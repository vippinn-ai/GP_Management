import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "supabase/operational-lifecycle-v2.sql"), "utf8");
const stagingDatasetIdentity = readFileSync(path.join(process.cwd(), "supabase/operational-performance-dataset-identity-staging.sql"), "utf8");
const customerTabSource = readFileSync(path.join(process.cwd(), "supabase/phase4-customer-tab-rpcs.sql"), "utf8");
const startSessionSource = readFileSync(path.join(process.cwd(), "supabase/phase4-start-session-rpc.sql"), "utf8");
const linkContinuationSource = readFileSync(path.join(process.cwd(), "supabase/phase4-link-customer-tab-continuation-rpc.sql"), "utf8");
const preflight = readFileSync(path.join(process.cwd(), "supabase/operational-lifecycle-v2-staging-preflight-readonly.sql"), "utf8");
const postflight = readFileSync(path.join(process.cwd(), "supabase/operational-lifecycle-v2-staging-postflight-readonly.sql"), "utf8");
const stagingEnvironmentIdentity = readFileSync(path.join(process.cwd(), "supabase/operational-v2-staging-environment-identity.sql"), "utf8");
const installer = readFileSync(path.join(process.cwd(), "scripts/build-operational-lifecycle-v2-staging-install.mjs"), "utf8");
const reinstallBuilder = readFileSync(path.join(process.cwd(), "scripts/build-operational-lifecycle-v2-staging-reinstall.mjs"), "utf8");
const postflightVerifier = readFileSync(path.join(process.cwd(), "scripts/verify-operational-lifecycle-v2-staging-postflight.mjs"), "utf8");
const transactionalProof = readFileSync(path.join(process.cwd(), "supabase/operational-lifecycle-v2-transactional-proof.sql"), "utf8");
const transactionalProofBuilder = readFileSync(path.join(process.cwd(), "scripts/build-operational-v2-transactional-proof.mjs"), "utf8");

function body(name: string) {
  const match = source.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1];
}

describe("normalized lifecycle v2 SQL contract", () => {
  for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"]) {
    it(`${name} never references compatibility app_state`, () => {
      const functionBody = body(name);
      expect(functionBody).not.toMatch(/\bapp_state\b/i);
      expect(functionBody).not.toMatch(/patch_app_state/i);
      expect(functionBody).toMatch(/auth\.uid\(\)/i);
      expect(functionBody).toMatch(/operational_mutations/i);
      expect(functionBody).toMatch(/mutation_identity_mismatch/i);
      expect(functionBody).toMatch(/for update/i);
    });
  }

  it("keeps v2 additive and authenticated-only", () => {
    expect(source).not.toMatch(/drop\s+function\s+.*(?:hop_session|reject_session|reject_customer_tab)\s*\(/i);
    for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"]) {
      expect(source).toContain(`revoke execute on function public.${name}(jsonb) from anon`);
      expect(source).toContain(`grant execute on function public.${name}(jsonb) to authenticated`);
    }
  });

  it("keeps the expensive dataset fingerprint RPC in staging-only test instrumentation", () => {
    expect(source).not.toContain("get_operational_performance_dataset_identity");
    expect(stagingDatasetIdentity).toContain("get_operational_performance_dataset_identity");
    expect(stagingDatasetIdentity).toContain("PII-free exact dataset identity");
    expect(installer).toContain("operational-performance-dataset-identity-staging.sql");
  });

  it("returns the application error contract for non-object envelopes without invoking object iterators on arrays", () => {
    for (const name of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"]) {
      const functionBody = body(name);
      expect(functionBody).toMatch(/jsonb_typeof\(payload\)\s+is\s+distinct\s+from\s+'object'/i);
      expect(functionBody).toMatch(/jsonb_typeof\(payload->'payload'\)\s+is\s+distinct\s+from\s+'object'/i);
      expect(functionBody).toContain("case when jsonb_typeof(payload)='object' then payload else '{}'::jsonb end");
      expect(functionBody).toContain("case when jsonb_typeof(payload->'payload')='object' then payload->'payload' else '{}'::jsonb end");
    }
  });

  it("rejects omitted and empty lifecycle discriminators with null-safe SQL guards", () => {
    for (const [name, kindVariable, expectedKind, typeVariable, expectedType] of [
      ["hop_session_v2", "v_mutation_kind", "hopSession", "v_entity_type", "session"],
      ["reject_session_v2", "v_mutation_kind", "rejectSession", "v_entity_type", "session"],
      ["reject_customer_tab_v2", "v_kind", "rejectCustomerTab", "v_type", "customer_tab"]
    ] as const) {
      const functionBody = body(name);
      expect(functionBody).toMatch(new RegExp(`${kindVariable}\\s+is\\s+distinct\\s+from\\s+'${expectedKind}'`, "i"));
      expect(functionBody).toMatch(new RegExp(`${typeVariable}\\s+is\\s+distinct\\s+from\\s+'${expectedType}'`, "i"));
      expect(functionBody).toMatch(new RegExp(`${kindVariable}\\s+text\\s*:=\\s*nullif\\(payload->>'mutation_kind',\\s*''\\)`, "i"));
      expect(functionBody).toMatch(new RegExp(`${typeVariable}\\s+text\\s*:=\\s*nullif\\(payload->>'entity_type',\\s*''\\)`, "i"));
    }
  });

  it("forces server-owned terminal fields and records exact changed IDs", () => {
    expect(body("hop_session_v2")).toMatch(/closed_bill_id\s*=\s*null/i);
    expect(body("hop_session_v2")).toMatch(/close_disposition\s*=\s*'hopped'/i);
    expect(body("reject_session_v2")).toMatch(/continued_from_session_ids\s*=\s*'\[\]'::jsonb/i);
    expect(body("reject_customer_tab_v2")).toMatch(/continued_from_session_ids\s*=\s*'\[\]'::jsonb/i);
    expect(source).toMatch(/'operational_events',\s*jsonb_build_array\(/i);
  });

  it("rejects billed targets and inconsistent pause state before terminal updates", () => {
    expect(body("hop_session_v2")).toMatch(/session_already_billed/i);
    expect(body("hop_session_v2")).toMatch(/status\s*=\s*'paused'[\s\S]*?open_pause_count\s*<>\s*1/i);
    expect(body("hop_session_v2")).toMatch(/paused_at\s*>\s*v_effective_end/i);
    expect(body("reject_session_v2")).toMatch(/session_already_billed/i);
    expect(body("reject_session_v2")).toMatch(/invalid_pause_state/i);
    expect(body("reject_customer_tab_v2")).toMatch(/customer_tab_already_billed/i);
  });

  it("locks and validates every hopped source before opening a continuation tab", () => {
    const match = customerTabSource.match(/create or replace function public\.open_customer_tab\(payload jsonb\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/i);
    expect(match).not.toBeNull();
    const functionBody = match![1];
    expect(functionBody).toMatch(/auth\.uid\(\)/i);
    expect(functionBody).toMatch(/v_user_id\s+is\s+distinct\s+from\s+v_actor::text/i);
    expect(functionBody).toMatch(/hop-source/i);
    expect(functionBody).toMatch(/for update/i);
    expect(functionBody).toMatch(/hopped_session_unavailable/i);
    expect(functionBody).toMatch(/hopped_session_already_continued/i);
    expect(functionBody).toMatch(/hopped_session_customer_mismatch/i);
    expect(functionBody).toMatch(/request_fingerprint/i);
    expect(functionBody).toMatch(/audit_id_conflict/i);
    expect(functionBody).toMatch(/closed_bill_id\s+is\s+null/i);
  });

  it("keeps preflight and postflight read-only and compatibility-hash aware", () => {
    for (const probe of [preflight, postflight]) {
      expect(probe).toMatch(/begin isolation level repeatable read read only/i);
      expect(probe).toMatch(/rollback;\s*$/i);
      expect(probe).toMatch(/md5\(data::text\)/i);
      expect(probe).not.toMatch(/\b(?:insert\s+into|update|delete\s+from|alter\s+table|drop\s+table|create\s+table)\s+public\./i);
    }
  });

  it("atomically anchors the exact physical staging cluster and refuses lookalike databases", () => {
    expect(stagingEnvironmentIdentity).toContain("system_identifier::text from pg_control_system()");
    expect(stagingEnvironmentIdentity).toContain("system_id <> '7623125441096521075'");
    expect(stagingEnvironmentIdentity).toContain("physical database is not the approved staging cluster");
    expect(stagingEnvironmentIdentity).toMatch(/organizations where id='org-primary' and active is true/i);
    expect(stagingEnvironmentIdentity).not.toContain("rrdwbxvuwrbxefarxnse");
    expect(stagingEnvironmentIdentity).toMatch(/^begin;[\s\S]*commit;\s*$/im);
    expect(stagingEnvironmentIdentity).not.toMatch(/alter database|set_config|app\.settings\.api_url/i);
  });

  it("binds continuation-chain actors to the authenticated principal", () => {
    for (const functionSource of [startSessionSource, customerTabSource, linkContinuationSource]) {
      expect(functionSource).toMatch(/auth\.uid\(\)/i);
      expect(functionSource).toMatch(/v_user_id\s+is\s+distinct\s+from\s+v_actor::text/i);
      expect(functionSource).toMatch(/created_by[\s\S]*?v_actor::text/i);
    }
  });

  it("serializes continuation-chain replay by organization and mutation before target locks", () => {
    for (const [name, functionSource] of [
      ["start_session", startSessionSource],
      ["open_customer_tab", customerTabSource],
      ["link_customer_tab_continuation", linkContinuationSource]
    ] as const) {
      const match = functionSource.match(new RegExp(`create or replace function public\\.${name}\\(payload jsonb\\)[\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"));
      expect(match, `Missing ${name}`).not.toBeNull();
      const functionBody = match![1];
      const mutationLock = functionBody.search(/pg_advisory_xact_lock\(hashtextextended\(v_(?:organization_id|org)\s*\|\|\s*chr\(31\)\s*\|\|\s*v_(?:mutation_id|mid)/i);
      const replayLookup = functionBody.search(/from public\.operational_events[\s\S]{0,220}metadata->>'mutation_id'/i);
      expect(mutationLock, `${name} mutation lock`).toBeGreaterThanOrEqual(0);
      expect(replayLookup, `${name} replay lookup`).toBeGreaterThan(mutationLock);
    }
  });

  it("builds immutable preflight-bound install and rollback evidence", () => {
    expect(installer).toMatch(/argument\("preflight"\)/i);
    expect(installer).toMatch(/deployed definition drift/i);
    expect(installer).toMatch(/actual_owner/i);
    expect(installer).toMatch(/actual_config/i);
    expect(installer).toMatch(/actual_acl/i);
    expect(preflight).toContain("system_identifier::text from pg_control_system()");
    expect(preflight).toContain("recoverable_hopped_sessions");
    expect(postflight).toContain("system_identifier::text from pg_control_system()");
    expect(installer).toMatch(/staging-rollback\.sql/i);
    expect(installer).toContain("aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))");
    expect(installer).toMatch(/flag:\s*"wx"/i);
    expect(installer).toMatch(/install changed compatibility app_state/i);
    expect(postflight).toMatch(/operational_mutations_rls/i);
    expect(postflightVerifier).toMatch(/appStateUnchanged:\s*true/i);
    expect(postflightVerifier).toMatch(/Compatibility app_state .* changed/i);
    expect(postflightVerifier).toContain("physical database identity drift");
    expect(postflightVerifier).toContain("installed definition, owner, configuration, or ACL drift");
    expect(postflight).toContain("acl_detail");
    expect(preflight).toContain("get_operational_performance_dataset_identity");
  });

  it("provides a narrow guarded reinstall for already-installed v2 corrections", () => {
    expect(reinstallBuilder).toContain('const PATCHED_FUNCTIONS = ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"]');
    expect(reinstallBuilder).toContain("for (const name of VERIFIED_FUNCTIONS) validateFunctionEvidence");
    expect(reinstallBuilder).toContain("deployed definition, owner, configuration, or ACL drift");
    expect(reinstallBuilder).toContain("installed definition, owner, configuration, or ACL mismatch");
    expect(reinstallBuilder).toContain("app_state changed after approved preflight");
    expect(reinstallBuilder).toContain("reinstall changed compatibility app_state");
    expect(reinstallBuilder).toContain('flag: "wx"');
    expect(reinstallBuilder).toContain('operation: "staging-v2-function-reinstall"');
  });

  it("provides an immutable rollback-only transactional proof for all lifecycle v2 functions", () => {
    expect(transactionalProof).toContain("OPERATIONAL_LIFECYCLE_V2_TRANSACTIONAL_PROOF");
    for (const functionName of ["hop_session_v2", "reject_session_v2", "reject_customer_tab_v2"]) {
      expect(transactionalProof).toContain(`public.${functionName}`);
    }
    for (const proofCase of [
      "Same mutation ID with different intent",
      "Malformed hop payload",
      "Future session end",
      "Client actor spoof field",
      "Late audit collision",
      "Inactive actor",
      "Anonymous actor",
      "Wrong organization",
      "missing-mutation-id",
      "missing-mutation-kind",
      "missing-entity-type",
      "empty-hop-mutation-kind",
      "empty-hop-entity-type",
      "missing-reject-session-mutation-kind",
      "missing-reject-session-entity-type",
      "empty-reject-session-mutation-kind",
      "empty-reject-session-entity-type",
      "missing-reject-tab-mutation-kind",
      "missing-reject-tab-entity-type",
      "empty-reject-tab-mutation-kind",
      "empty-reject-tab-entity-type",
      "same-id-different-kind",
      "same-id-different-entity",
      "same-id-different-audit"
    ]) expect(transactionalProof).toContain(proofCase);
    expect(transactionalProof.match(/pg_temp\.qa_expect_rpc_error\('/g)).toHaveLength(48);
    expect(transactionalProof).toContain("insert into qa_negative_results values('unsupported-role'");
    expect(transactionalProof).toContain("original_sqlstate = RETURNED_SQLSTATE");
    expect(transactionalProof).toContain("qa_error_code('not-json', '23502') = '23502'");
    expect(transactionalProof).toContain("Operational v2 changed app_state");
    expect(transactionalProof).toMatch(/rollback;\s*$/i);
    expect(transactionalProof).not.toMatch(/\bcommit\s*;/i);
    expect(transactionalProofBuilder).toContain('flag: "wx"');
    expect(transactionalProofBuilder).toContain("rollbackOnly: true");
  });
});
