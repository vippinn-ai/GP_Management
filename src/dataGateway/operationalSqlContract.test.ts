import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const hopMigration = readFileSync(
  join(process.cwd(), "supabase", "phase4-hop-session-rpc.sql"),
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
});
