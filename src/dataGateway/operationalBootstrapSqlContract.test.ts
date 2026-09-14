import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/operational-bootstrap-v2.sql"), "utf8");
const preflight = readFileSync(resolve(process.cwd(), "supabase/operational-bootstrap-v2-staging-preflight-readonly.sql"), "utf8");
const postflight = readFileSync(resolve(process.cwd(), "supabase/operational-bootstrap-v2-staging-postflight-readonly.sql"), "utf8");
const installer = readFileSync(resolve(process.cwd(), "scripts/build-operational-bootstrap-v2-staging-install.mjs"), "utf8");
const body = sql.match(/as \$\$([\s\S]*?)\$\$;/i)?.[1] ?? "";

describe("operational bootstrap v2 SQL contract", () => {
  it("is additive, authenticated-only, stable, bounded, and read-only", () => {
    expect(sql).toMatch(/create or replace function public\.load_operational_bootstrap_v2\(\s*\)/i);
    expect(sql).toMatch(/language plpgsql\s+stable\s+security definer/i);
    expect(sql).toMatch(/set search_path = pg_catalog\b/i);
    expect(sql).toMatch(/set statement_timeout = '5s'/i);
    expect(sql).toMatch(/revoke all on function public\.load_operational_bootstrap_v2\(\) from public/i);
    expect(sql).toMatch(/revoke all on function public\.load_operational_bootstrap_v2\(\) from anon/i);
    expect(sql).toMatch(/revoke all on function public\.load_operational_bootstrap_v2\(\) from service_role/i);
    expect(sql).toMatch(/grant execute on function public\.load_operational_bootstrap_v2\(\) to authenticated/i);
    expect(body).toMatch(/auth\.uid\(\)/i);
    expect(body).not.toMatch(/\b(insert|update|delete|merge|truncate|execute)\b/i);
    expect(body).not.toMatch(/app_state\s*\.\s*data|state\s*\.\s*data/i);
    expect(body).toMatch(/octet_length\(v_result::text\) > 160992/i);
  });

  it("checks active profile before organization membership integrity", () => {
    const profileCheck = body.indexOf("from public.profiles as profile");
    const inactiveReturn = body.indexOf("'inactive-or-missing'");
    const membershipCheck = body.indexOf("from public.organization_members as membership");

    expect(profileCheck).toBeGreaterThan(-1);
    expect(inactiveReturn).toBeGreaterThan(profileCheck);
    expect(membershipCheck).toBeGreaterThan(inactiveReturn);
    expect(body).toMatch(/if v_membership_count <> 1 then/i);
    expect(body).toMatch(/bootstrap_role_mismatch/i);
  });

  it("returns the fixed critical collections and excludes deferred histories", () => {
    for (const key of [
      "profiles", "inventory_categories", "stations", "pricing_rules", "inventory_items",
      "sale_variants", "combos", "combo_station_targets", "combo_fixed_items",
      "combo_choice_groups", "combo_choice_options", "sessions", "session_pause_logs",
      "session_items", "session_combo_applications", "customer_tabs", "customer_tab_items",
      "customer_tab_combo_applications"
    ]) {
      expect(body).toContain(`'${key}'`);
    }
    expect(body).not.toMatch(/public\.(bills|payments|expenses|audit_logs|stock_movements)\b/i);
    expect(body).toMatch(/bootstrap_collection_limit_exceeded/i);
  });

  it("tenant-predicates every normalized operational collection", () => {
    for (const alias of [
      "membership", "category", "station", "rule", "item", "variant", "combo", "target",
      "fixed", "choice_group", "choice_option", "session", "pause", "applied", "tab"
    ]) {
      expect(body).toMatch(new RegExp(`${alias}\\.organization_id = v_organization_id`, "i"));
    }
  });

  it("uses deterministic ordering for every aggregated collection", () => {
    const aggregateCount = (body.match(/jsonb_agg\(/gi) ?? []).length;
    const orderedAggregateCount = (body.match(/jsonb_agg\([^\n]+order by/gi) ?? []).length;
    expect(aggregateCount).toBe(18);
    expect(orderedAggregateCount).toBe(aggregateCount);
  });
});

describe("operational bootstrap staging controls", () => {
  it("binds preflight evidence to staging, app_state, the prior function, and realtime RLS", () => {
    expect(preflight).toMatch(/begin isolation level repeatable read read only/i);
    expect(preflight).toContain("tkbdyzxwwbhkpztgjjxh");
    expect(preflight).toContain("7623125441096521075");
    expect(preflight).toContain("deployment_environment_identity");
    expect(preflight).toContain("pg_get_functiondef(oid)");
    expect(preflight).toContain("acl_detail");
    expect(preflight).toContain("'installer_role', current_user");
    expect(preflight).toContain("replace(replace(btrim(prosrc, E' \\t\\n\\r')");
    expect(preflight).toContain("'permissive', permissive");
    expect(preflight).toContain("'authenticated_role_memberships'");
    expect(preflight).toContain("join pg_auth_members membership");
    expect(preflight).toContain("'owner_name', pg_get_userbyid(helper.proowner)");
    expect(preflight).toContain("canonical function-body newline normalization failed");
    expect(preflight).toContain("current_user_has_org_access(text)");
    expect(preflight).toContain("relrowsecurity");
    expect(preflight.trimEnd()).toMatch(/rollback;$/i);
  });

  it("executes the function inside a read-only postflight and verifies shape, bytes, and ACL", () => {
    expect(postflight).toMatch(/begin isolation level repeatable read read only/i);
    expect(postflight).toContain("payload := public.load_operational_bootstrap_v2()");
    expect(postflight).toContain("bootstrap response keys mismatch");
    expect(postflight).toContain("octet_length(payload::text) > 160992");
    expect(postflight).toContain("has_function_privilege('anon'");
    expect(postflight).toContain("'service_role_execute'");
    expect(postflight).toContain("not in (function_owner, 'authenticated')");
    expect(postflight).toContain("has_function_privilege('authenticated'");
    expect(postflight).toContain("applicable_select_policies");
    expect(postflight).toContain("join pg_auth_members membership");
    expect(postflight).toContain("operational_events realtime RLS, publication, or inherited-role policy proof failed");
    expect(postflight).toContain("organization access helper identity or ACL proof failed");
    expect(postflight).toContain("'realtime_security'");
    expect(postflight.trimEnd()).toMatch(/rollback;$/i);
  });

  it("generates immutable preflight-bound install and exact rollback artifacts", () => {
    expect(installer).toContain("bootstrap function definition, owner, configuration, or ACL changed after preflight");
    expect(installer).toContain("unexpected bootstrap function appeared after preflight");
    expect(installer).toContain("bootstrap install changed app_state");
    expect(installer).toContain("realtime publication, RLS policy, or access helper changed after preflight");
    expect(installer).toContain("rollback refused unexpected bootstrap definition, owner, configuration, ACL, or security drift");
    expect(installer).toContain("Source worktree must be clean before staging artifacts are built.");
    expect(installer).toContain('const sourceCommit = argument("source-commit")');
    expect(installer).toContain("previous.definition.trim() + \";\"");
    expect(installer).toContain("definition_md5 is distinct from");
    expect(installer).toContain("authenticatedRoleMemberships");
    expect(installer).toContain("drop function public.${FUNCTION}();");
    expect(installer).toContain('flag: "wx"');
  });
});
