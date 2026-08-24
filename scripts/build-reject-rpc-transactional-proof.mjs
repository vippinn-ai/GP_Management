import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const definitionFiles = [
  "supabase/phase4-start-session-rpc.sql",
  "supabase/phase4-reject-rpcs.sql",
  "supabase/phase4-link-customer-tab-continuation-rpc.sql"
];
const proofBodyPath = "supabase/phase4-reject-rpcs-transactional-proof.sql";
const outputPath = "test-artifacts/sql/reject-rpc-staging-transactional-proof.sql";

const definitions = definitionFiles.map((relativePath) => {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  if (!content.includes("create or replace function public.")) {
    throw new Error(`${relativePath} does not contain a production function definition.`);
  }
  return {
    relativePath,
    content,
    sha256: createHash("sha256").update(content).digest("hex")
  };
});
const proofBody = fs.readFileSync(path.join(root, proofBodyPath), "utf8");
if (!proofBody.includes("QA_REJECT_RPC_PROOF_BODY") || /\bcommit\s*;/i.test(proofBody)) {
  throw new Error("Transactional proof body is missing its guard marker or contains COMMIT.");
}

const functionCandidates = `(values
  ('public.start_session(jsonb)'),
  ('public.reject_session(jsonb)'),
  ('public.reject_customer_tab(jsonb)'),
  ('public.link_customer_tab_continuation(jsonb)')
) as candidate(signature)`;

const hashQuery = (stage) => `
select
  '${stage}' as proof_stage,
  candidate.signature,
  encode(digest(pg_get_functiondef(candidate.signature::regprocedure::oid), 'sha256'), 'hex') as definition_sha256,
  has_function_privilege('authenticated', candidate.signature, 'execute') as authenticated_can_execute,
  has_function_privilege('anon', candidate.signature, 'execute') as anon_can_execute
from ${functionCandidates}
order by candidate.signature;
`;

const beforeSnapshot = `
create temp table qa_reject_rpc_definition_before on commit preserve rows as
select
  candidate.signature,
  encode(digest(pg_get_functiondef(candidate.signature::regprocedure::oid), 'sha256'), 'hex') as definition_sha256,
  has_function_privilege('authenticated', candidate.signature, 'execute') as authenticated_can_execute,
  has_function_privilege('anon', candidate.signature, 'execute') as anon_can_execute
from ${functionCandidates};

select 'before' as proof_stage, *
from qa_reject_rpc_definition_before
order by signature;

create temp table qa_reject_rpc_app_state_before on commit preserve rows as
select
  app_state.id,
  app_state.version,
  encode(digest(app_state.data::text, 'sha256'), 'hex') as data_sha256
from public.app_state
where app_state.id = 'primary';

select 'before' as proof_stage, *
from qa_reject_rpc_app_state_before;

create temp table qa_reject_rpc_fixture_ids_before (
  fixture_kind text not null,
  fixture_id text not null
) on commit preserve rows;

insert into qa_reject_rpc_fixture_ids_before (fixture_kind, fixture_id)
values
  ('session', 'qa-reject-proof-source-session'),
  ('session', 'qa-reject-proof-consumer-session'),
  ('session', 'qa-reject-proof-source-tab'),
  ('session', 'qa-reject-proof-stale-session'),
  ('session', 'qa-reject-proof-spoof-session'),
  ('session', 'qa-reject-proof-audit-session'),
  ('session', 'qa-reject-proof-malformed-session'),
  ('session', 'qa-reject-proof-start-source'),
  ('session', 'qa-reject-proof-start-stale-consumer'),
  ('session', 'qa-reject-proof-start-new-consumer'),
  ('session', 'qa-reject-proof-link-source'),
  ('customer_tab', 'qa-reject-proof-consumer-tab'),
  ('customer_tab', 'qa-reject-proof-link-stale-consumer'),
  ('customer_tab', 'qa-reject-proof-link-target'),
  ('station', 'qa-reject-proof-start-station'),
  ('audit', 'qa-reject-proof-existing-audit'),
  ('audit', 'qa-reject-proof-session-audit'),
  ('audit', 'qa-reject-proof-tab-audit'),
  ('audit', 'qa-reject-proof-stale-audit'),
  ('audit', 'qa-reject-proof-spoof-audit'),
  ('audit', 'qa-reject-proof-malformed-audit'),
  ('audit', 'qa-reject-proof-inactive-audit'),
  ('mutation', 'qa-reject-proof-session-mutation'),
  ('mutation', 'qa-reject-proof-tab-mutation'),
  ('mutation', 'qa-reject-proof-stale-mutation'),
  ('mutation', 'qa-reject-proof-spoof-mutation'),
  ('mutation', 'qa-reject-proof-audit-collision-mutation'),
  ('mutation', 'qa-reject-proof-malformed-mutation'),
  ('mutation', 'qa-reject-proof-inactive-mutation'),
  ('mutation', 'qa-reject-proof-start-mutation'),
  ('mutation', 'qa-reject-proof-link-mutation');
`;

const rollbackVerification = `
do $$
declare
  mismatch_count integer;
  app_state_mismatch_count integer;
  fixture_residual_count integer;
begin
  select count(*)
  into mismatch_count
  from qa_reject_rpc_definition_before before_snapshot
  full join (
    select
      candidate.signature,
      encode(digest(pg_get_functiondef(candidate.signature::regprocedure::oid), 'sha256'), 'hex') as definition_sha256,
      has_function_privilege('authenticated', candidate.signature, 'execute') as authenticated_can_execute,
      has_function_privilege('anon', candidate.signature, 'execute') as anon_can_execute
    from ${functionCandidates}
  ) after_snapshot using (signature)
  where before_snapshot.signature is null
    or after_snapshot.signature is null
    or before_snapshot.definition_sha256 is distinct from after_snapshot.definition_sha256
    or before_snapshot.authenticated_can_execute is distinct from after_snapshot.authenticated_can_execute
    or before_snapshot.anon_can_execute is distinct from after_snapshot.anon_can_execute;

  if (select count(*) from qa_reject_rpc_definition_before) <> 4 or mismatch_count <> 0 then
    raise exception using
      errcode = 'QA010',
      message = 'SAVEPOINT rollback did not restore all four function definitions and grants exactly.';
  end if;

  select count(*)
  into app_state_mismatch_count
  from qa_reject_rpc_app_state_before before_snapshot
  full join (
    select
      app_state.id,
      app_state.version,
      encode(digest(app_state.data::text, 'sha256'), 'hex') as data_sha256
    from public.app_state
    where app_state.id = 'primary'
  ) after_snapshot using (id)
  where before_snapshot.id is null
    or after_snapshot.id is null
    or before_snapshot.version is distinct from after_snapshot.version
    or before_snapshot.data_sha256 is distinct from after_snapshot.data_sha256;

  if (select count(*) from qa_reject_rpc_app_state_before) <> 1 or app_state_mismatch_count <> 0 then
    raise exception using
      errcode = 'QA011',
      message = 'SAVEPOINT rollback did not restore the original app_state version and data hash exactly.';
  end if;

  select
    (select count(*) from public.sessions session_row join qa_reject_rpc_fixture_ids_before fixture on fixture.fixture_kind = 'session' and fixture.fixture_id = session_row.id where session_row.organization_id = 'org-primary') +
    (select count(*) from public.customer_tabs tab_row join qa_reject_rpc_fixture_ids_before fixture on fixture.fixture_kind = 'customer_tab' and fixture.fixture_id = tab_row.id where tab_row.organization_id = 'org-primary') +
    (select count(*) from public.stations station_row join qa_reject_rpc_fixture_ids_before fixture on fixture.fixture_kind = 'station' and fixture.fixture_id = station_row.id where station_row.organization_id = 'org-primary') +
    (select count(*) from public.audit_logs audit_row where audit_row.organization_id = 'org-primary' and (
      exists (select 1 from qa_reject_rpc_fixture_ids_before fixture where fixture.fixture_kind = 'audit' and fixture.fixture_id = audit_row.id)
      or exists (select 1 from qa_reject_rpc_fixture_ids_before fixture where fixture.fixture_kind in ('session', 'customer_tab') and fixture.fixture_id = audit_row.entity_id)
    )) +
    (select count(*) from public.operational_events event_row where event_row.organization_id = 'org-primary' and (
      exists (select 1 from qa_reject_rpc_fixture_ids_before fixture where fixture.fixture_kind in ('session', 'customer_tab') and fixture.fixture_id = event_row.entity_id)
      or exists (select 1 from qa_reject_rpc_fixture_ids_before fixture where fixture.fixture_kind = 'mutation' and fixture.fixture_id = event_row.metadata->>'mutation_id')
    )) +
    (select count(*)
      from public.app_state state
      cross join lateral jsonb_array_elements(
        coalesce(state.data->'sessions', '[]'::jsonb) ||
        coalesce(state.data->'customerTabs', '[]'::jsonb) ||
        coalesce(state.data->'auditLogs', '[]'::jsonb) ||
        coalesce(state.data->'stations', '[]'::jsonb)
      ) entry
      where state.id = 'primary'
        and exists (
          select 1 from qa_reject_rpc_fixture_ids_before fixture
          where fixture.fixture_kind <> 'mutation' and fixture.fixture_id = entry->>'id'
        ))
  into fixture_residual_count;

  if fixture_residual_count <> 0 then
    raise exception using
      errcode = 'QA012',
      message = 'SAVEPOINT rollback left one or more proof fixtures behind.';
  end if;
end;
$$;

${hashQuery("after")}

select 'after' as proof_stage, app_state.id, app_state.version,
  encode(digest(app_state.data::text, 'sha256'), 'hex') as data_sha256
from public.app_state
where app_state.id = 'primary';

drop table qa_reject_rpc_definition_before;
drop table qa_reject_rpc_app_state_before;
drop table qa_reject_rpc_fixture_ids_before;

commit;

select
  'passed' as proof_result,
  3 as verified_in_savepoint_app_state_version_delta,
  app_state.version as restored_app_state_version,
  encode(digest(app_state.data::text, 'sha256'), 'hex') as restored_app_state_sha256
from public.app_state
where app_state.id = 'primary';
`;

const generated = [
  "-- GENERATED FILE. Do not edit by hand.",
  "-- Staging-only exact-definition proof. Every function and fixture change is rolled back to a savepoint.",
  ...definitions.map((entry) => `-- ${entry.relativePath} SHA-256 ${entry.sha256}`),
  `-- ${proofBodyPath} SHA-256 ${createHash("sha256").update(proofBody).digest("hex")}`,
  "begin;",
  beforeSnapshot,
  "savepoint qa_reject_rpc_proof;",
  "set local lock_timeout = '3s';",
  "set local statement_timeout = '25s';",
  ...definitions.flatMap((entry) => [
    `-- BEGIN EXACT ${entry.relativePath}`,
    entry.content.trim(),
    `-- END EXACT ${entry.relativePath}`
  ]),
  hashQuery("during"),
  proofBody.trim(),
  "rollback to savepoint qa_reject_rpc_proof;",
  "release savepoint qa_reject_rpc_proof;",
  rollbackVerification,
  "-- Expected: proof_result reports passed and post-savepoint assertions restore all four hashes, grants, and app_state."
].join("\n\n") + "\n";

const savepointCount = (generated.match(/^savepoint qa_reject_rpc_proof;$/gim) ?? []).length;
const rollbackToCount = (generated.match(/^rollback to savepoint qa_reject_rpc_proof;$/gim) ?? []).length;
const releaseCount = (generated.match(/^release savepoint qa_reject_rpc_proof;$/gim) ?? []).length;
const beginCount = (generated.match(/^begin;$/gim) ?? []).length;
const commitCount = (generated.match(/^commit;$/gim) ?? []).length;
const fullRollbackCount = (generated.match(/^rollback;$/gim) ?? []).length;
const normalizedGenerated = generated.replace(/\r\n/g, "\n");
const requiredOrder = [
  "\nbegin;\n",
  "create temp table qa_reject_rpc_definition_before",
  "\nsavepoint qa_reject_rpc_proof;\n",
  "\nrollback to savepoint qa_reject_rpc_proof;\n",
  "\nrelease savepoint qa_reject_rpc_proof;\n",
  "drop table qa_reject_rpc_fixture_ids_before;",
  "\ncommit;\n",
  "3 as verified_in_savepoint_app_state_version_delta"
].map((marker) => normalizedGenerated.indexOf(marker));
const hasRequiredOrder = requiredOrder.every(
  (position, index) => position >= 0 && (index === 0 || position > requiredOrder[index - 1])
);
if (
  savepointCount !== 1 ||
  rollbackToCount !== 1 ||
  releaseCount !== 1 ||
  beginCount !== 1 ||
  commitCount !== 1 ||
  fullRollbackCount !== 0 ||
  !hasRequiredOrder
) {
  throw new Error("Generated proof must contain one correctly ordered outer BEGIN/COMMIT, one SAVEPOINT/ROLLBACK TO/RELEASE, post-rollback cleanup and assertions, and no full ROLLBACK.");
}
const outputDirectory = path.dirname(path.join(root, outputPath));
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(root, outputPath), generated, "utf8");

console.log(JSON.stringify({
  status: "generated",
  output: outputPath,
  generatedSha256: createHash("sha256").update(generated).digest("hex"),
  definitions: definitions.map(({ relativePath, sha256 }) => ({ relativePath, sha256 }))
}, null, 2));
