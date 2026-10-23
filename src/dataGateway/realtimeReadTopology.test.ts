import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_BACKEND_FEATURE_FLAGS } from "./featureFlags";
import { loadNormalizedRealtimeOverlay, type OperationalEventRow } from "./normalizedRealtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const parents = deferred<{ data: unknown[]; error: null }>();
  const audit = deferred<{ data: unknown[]; error: Error | null }>();
  const from = vi.fn((table: string) => {
    const result = table === "customer_tabs" ? parents.promise
      : table === "audit_logs" ? audit.promise : Promise.resolve({ data: [], error: null });
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      in: vi.fn(() => query), order: vi.fn(() => query),
      then: result.then.bind(result)
    };
    return query;
  });
  const event: OperationalEventRow = {
    id: "event", organization_id: "org", entity_id: "tab",
    entity_type: "customer_tab", event_type: "reject_customer_tab",
    created_at: "2026-10-20T00:00:00Z",
    metadata: { changed_rows: { customer_tabs: ["tab"], audit_logs: ["audit"] } }
  };
  return { parents, audit, from, event, client: { from } as unknown as SupabaseClient };
}
afterEach(() => vi.useRealTimers());

describe("realtime overlap with real normalized readers", () => {
  it("overlaps audit with parents but still loads children for a closed tab", async () => {
    const f = fixture();
    const result = loadNormalizedRealtimeOverlay(f.event, DEFAULT_BACKEND_FEATURE_FLAGS, f.client);
    expect(f.from.mock.calls.map(([table]) => table)).toEqual(["customer_tabs", "audit_logs"]);
    f.audit.resolve({ data: [], error: null });
    f.parents.resolve({ data: [{
      id: "tab", status: "closed", opened_at: "2026-10-20T00:00:00Z",
      closed_at: "2026-10-20T01:00:00Z", close_disposition: "rejected", raw_data: {}
    }], error: null });
    const overlay = await result;
    expect(f.from.mock.calls.map(([table]) => table)).toEqual([
      "customer_tabs", "audit_logs", "customer_tab_items", "customer_tab_combo_applications"
    ]);
    expect(overlay.appData.customerTabs?.[0]).toMatchObject({ id: "tab", status: "closed" });
    expect(overlay.refreshedSlices).toEqual(["changed_live_rows"]);
  });

  it("retains the existing read timeout and waits for the pending logical parent group after audit fails", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const result = loadNormalizedRealtimeOverlay(f.event, DEFAULT_BACKEND_FEATURE_FLAGS, f.client);
    const observed = result.then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; }
    );
    f.audit.resolve({ data: [], error: new Error("audit failed") });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await observed).toMatchObject({ message: "Unable to reach normalized data while loading normalized changed customer tabs." });
    expect(f.from.mock.calls.map(([table]) => table)).toEqual(["customer_tabs", "audit_logs"]);
    // A timeout settles the wrapper, not the underlying transport.
    f.parents.resolve({ data: [], error: null });
  });
});
