import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hopMigration = readFileSync(
  join(process.cwd(), "supabase", "phase4-hop-session-rpc.sql"),
  "utf8"
);
const rejectMigration = readFileSync(
  join(process.cwd(), "supabase", "phase4-reject-rpcs.sql"),
  "utf8"
);
const startSessionMigration = readFileSync(
  join(process.cwd(), "supabase", "phase4-start-session-rpc.sql"),
  "utf8"
);
const linkCustomerTabContinuationMigration = readFileSync(
  join(process.cwd(), "supabase", "phase4-link-customer-tab-continuation-rpc.sql"),
  "utf8"
);

describe("operational SQL contract", () => {
  it("preserves the locked normalized session start during a game hop", () => {
    expect(hopMigration).toMatch(
      /select sessions\.status, sessions\.started_at\s+into v_current_status, v_current_started_at[\s\S]*for update/i
    );
    expect(hopMigration).toMatch(/v_current_started_at is null[\s\S]*invalid_session_timing/i);
    expect(hopMigration).toMatch(
      /v_session := jsonb_set\(v_session, '\{startedAt\}', to_jsonb\(v_current_started_at\), true\)[\s\S]*update public\.sessions/i
    );
    expect(hopMigration).toMatch(/raw_data = v_session/i);
    expect(hopMigration).toMatch(/patch_app_state_array_by_id[\s\S]*jsonb_build_array\(v_session\)/i);
  });

  it("atomically releases continuation links when rejecting sessions and customer tabs", () => {
    const rejectSessionBody = rejectMigration.match(
      /create or replace function public\.reject_session\(payload jsonb\)([\s\S]*?)create or replace function public\.reject_customer_tab/i
    )?.[1] ?? "";
    const rejectCustomerTabBody = rejectMigration.match(
      /create or replace function public\.reject_customer_tab\(payload jsonb\)([\s\S]*)$/i
    )?.[1] ?? "";

    for (const body of [rejectSessionBody, rejectCustomerTabBody]) {
      expect(body).toMatch(/v_actor uuid := auth\.uid\(\)/i);
      expect(body).toMatch(/v_user_id is distinct from v_actor::text/i);
      expect(body).toMatch(/current_user_org_role\(v_organization_id\)/i);
      expect(body).toMatch(/pg_advisory_xact_lock\(hashtextextended\(v_organization_id \|\| chr\(31\) \|\| v_mutation_id/i);
      expect(body.indexOf("pg_advisory_xact_lock")).toBeLessThan(body.indexOf("from public.operational_events"));
      expect(body).toMatch(/mutation_identity_mismatch/i);
      expect(body).toMatch(/select[\s\S]*continued_from_session_ids[\s\S]*for update/i);
      expect(body).toMatch(/jsonb_set\(v_(?:session|tab), '\{continuedFromSessionIds\}', '\[\]'::jsonb, true\)/i);
      expect(body).toMatch(/jsonb_set\(v_(?:session|tab), '\{closedBillId\}', 'null'::jsonb, true\)/i);
      expect(body).toMatch(/jsonb_typeof\(coalesce\([\s\S]*continued_from_session_ids[\s\S]*\) = 'array'/i);
      expect(body).toMatch(/jsonb_array_length\(v_released_continuation_ids\)/i);
      expect(body).toMatch(/jsonb_set\(v_audit_log, '\{message\}', to_jsonb\(v_audit_message\), true\)/i);
      expect(body).toMatch(/continued_from_session_ids = '\[\]'::jsonb/i);
      expect(body).toMatch(/closed_bill_id = null/i);
      expect(body).toMatch(/audit_id_conflict/i);
      expect(body).toMatch(/patch_app_state_array_by_id[\s\S]*jsonb_build_array\(v_(?:session|tab)\)/i);
      expect(body).toMatch(/'released_continued_from_session_ids', v_released_continuation_ids/i);
      expect(body).toMatch(/v_updated_by := v_actor/i);
    }
  });

  it("does not let rejected continuation consumers permanently consume a hopped source", () => {
    expect(startSessionMigration).toMatch(
      /from public\.sessions child[\s\S]*child\.status = 'closed'[\s\S]*child\.close_disposition is not distinct from 'rejected'[\s\S]*child\.closed_bill_id is null[\s\S]*continued_from_session_ids/i
    );
    expect(startSessionMigration).toMatch(
      /from public\.customer_tabs consumer_tab[\s\S]*consumer_tab\.status = 'closed'[\s\S]*consumer_tab\.close_disposition is not distinct from 'rejected'[\s\S]*consumer_tab\.closed_bill_id is null[\s\S]*continued_from_session_ids/i
    );
    expect(linkCustomerTabContinuationMigration).toMatch(
      /from public\.sessions child[\s\S]*child\.status = 'closed'[\s\S]*child\.close_disposition is not distinct from 'rejected'[\s\S]*child\.closed_bill_id is null[\s\S]*continued_from_session_ids/i
    );
    expect(linkCustomerTabContinuationMigration).toMatch(
      /from public\.customer_tabs consumer_tab[\s\S]*consumer_tab\.status = 'closed'[\s\S]*consumer_tab\.close_disposition is not distinct from 'rejected'[\s\S]*consumer_tab\.closed_bill_id is null[\s\S]*continued_from_session_ids/i
    );
  });
});
