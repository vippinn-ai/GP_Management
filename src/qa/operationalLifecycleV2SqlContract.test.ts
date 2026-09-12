import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "supabase/operational-lifecycle-v2.sql"), "utf8");
const customerTabSource = readFileSync(path.join(process.cwd(), "supabase/phase4-customer-tab-rpcs.sql"), "utf8");

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

  it("forces server-owned terminal fields and records exact changed IDs", () => {
    expect(body("hop_session_v2")).toMatch(/closed_bill_id\s*=\s*null/i);
    expect(body("hop_session_v2")).toMatch(/close_disposition\s*=\s*'hopped'/i);
    expect(body("reject_session_v2")).toMatch(/continued_from_session_ids\s*=\s*'\[\]'::jsonb/i);
    expect(body("reject_customer_tab_v2")).toMatch(/continued_from_session_ids\s*=\s*'\[\]'::jsonb/i);
    expect(source).toMatch(/'operational_events',\s*jsonb_build_array\(/i);
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
    expect(functionBody).toMatch(/closed_bill_id\s+is\s+null/i);
  });
});
