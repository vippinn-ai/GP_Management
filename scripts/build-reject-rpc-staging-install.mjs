import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const definitionFiles = [
  "supabase/phase4-start-session-rpc.sql",
  "supabase/phase4-reject-rpcs.sql",
  "supabase/phase4-link-customer-tab-continuation-rpc.sql"
];
const outputPath = "test-artifacts/sql/reject-rpc-staging-install.sql";

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

const functionCandidates = `(values
  ('public.raise_operational_rpc_error(text,text,jsonb)', false, false, false),
  ('public.patch_app_state_array_by_id(jsonb,jsonb)', false, false, false),
  ('public.start_session(jsonb)', true, false, true),
  ('public.reject_session(jsonb)', true, false, true),
  ('public.reject_customer_tab(jsonb)', true, false, true),
  ('public.link_customer_tab_continuation(jsonb)', true, false, true)
) as candidate(signature, expected_authenticated, expected_anon, expected_security_definer)`;

const verificationQuery = `select
  'reject_rpc_staging_install' as evidence_id,
  candidate.signature,
  encode(digest(pg_get_functiondef(candidate.signature::regprocedure::oid), 'sha256'), 'hex') as definition_sha256,
  has_function_privilege('authenticated', candidate.signature, 'execute') as authenticated_can_execute,
  has_function_privilege('anon', candidate.signature, 'execute') as anon_can_execute,
  procedure_row.prosecdef as security_definer
from ${functionCandidates}
join pg_proc procedure_row on procedure_row.oid = candidate.signature::regprocedure::oid
order by candidate.signature;`;

const verificationBlock = `do $$
declare
  mismatch_count integer;
begin
  select count(*)
  into mismatch_count
  from ${functionCandidates}
  join pg_proc procedure_row on procedure_row.oid = candidate.signature::regprocedure::oid
  where has_function_privilege('authenticated', candidate.signature, 'execute') is distinct from candidate.expected_authenticated
    or has_function_privilege('anon', candidate.signature, 'execute') is distinct from candidate.expected_anon
    or procedure_row.prosecdef is distinct from candidate.expected_security_definer;

  if mismatch_count <> 0 then
    raise exception using
      errcode = 'QA020',
      message = 'Installed reject-release RPC definitions or grants do not match the reviewed contract.';
  end if;
end;
$$;`;

const generated = [
  "-- GENERATED FILE. Do not edit by hand.",
  "-- Staging-only persistent installation for the independently proven reject-release RPC set.",
  ...definitions.map((entry) => `-- ${entry.relativePath} SHA-256 ${entry.sha256}`),
  "begin;",
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  ...definitions.flatMap((entry) => [
    `-- BEGIN EXACT ${entry.relativePath}`,
    entry.content.trim(),
    `-- END EXACT ${entry.relativePath}`
  ]),
  verificationBlock,
  "commit;",
  verificationQuery,
  "-- Expected: six rows with reviewed definition hashes, browser RPC grants true/false, helper grants false/false, and matching security-definer flags."
].join("\n\n") + "\n";

const normalizedGenerated = generated.replace(/\r\n/g, "\n");
const beginCount = (normalizedGenerated.match(/^begin;$/gim) ?? []).length;
const commitCount = (normalizedGenerated.match(/^commit;$/gim) ?? []).length;
const rollbackCount = (normalizedGenerated.match(/^rollback(?:\s+to\s+savepoint\s+\S+)?;$/gim) ?? []).length;
const requiredOrder = [
  "\nbegin;\n",
  "-- BEGIN EXACT supabase/phase4-start-session-rpc.sql",
  "-- BEGIN EXACT supabase/phase4-reject-rpcs.sql",
  "-- BEGIN EXACT supabase/phase4-link-customer-tab-continuation-rpc.sql",
  "\ndo $$\n",
  "\ncommit;\n",
  "'reject_rpc_staging_install' as evidence_id"
].map((marker) => normalizedGenerated.indexOf(marker));
const hasRequiredOrder = requiredOrder.every(
  (position, index) => position >= 0 && (index === 0 || position > requiredOrder[index - 1])
);

if (beginCount !== 1 || commitCount !== 1 || rollbackCount !== 0 || !hasRequiredOrder) {
  throw new Error("Generated installer must contain one correctly ordered BEGIN/COMMIT, exact definitions, pre-commit verification, and no ROLLBACK.");
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
