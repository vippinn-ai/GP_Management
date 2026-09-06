import { describe, expect, it, vi } from "vitest";
import {
  buildLocalActivityEvents,
  loadActivityFeedPage,
  mapActivityFeedPage,
  queryLocalActivityFeed
} from "./activityFeed";

describe("activity feed data gateway", () => {
  it("maps canonical server records and cursors", () => {
    const page = mapActivityFeedPage({
      items: [{
        id: "activity-1",
        occurred_at: "2026-09-06T10:00:00Z",
        actor_user_id: "actor-1",
        actor_name: "Vipin",
        actor_username: "vipin",
        actor_role: "admin",
        action: "bill_issued",
        category: "billing",
        entity_type: "bill",
        entity_id: "bill-1",
        entity_label: "BILL-1 · Vansh",
        summary: "Issued BILL-1.",
        details: { source: "audit_log" },
        source_kind: "audit_log",
        legacy: false
      }],
      actors: [{ user_id: "actor-1", name: "Vipin", username: "vipin", role: "admin" }],
      has_more: true,
      next_cursor: { occurred_at: "2026-09-06T10:00:00Z", id: "activity-1" }
    });

    expect(page.items[0]).toMatchObject({
      id: "activity-1",
      actorName: "Vipin",
      category: "billing",
      entityLabel: "BILL-1 · Vansh",
      legacy: false
    });
    expect(page.actors).toEqual([{ userId: "actor-1", name: "Vipin", username: "vipin", role: "admin" }]);
    expect(page.nextCursor).toEqual({ occurredAt: "2026-09-06T10:00:00Z", id: "activity-1" });
  });

  it("sends bounded server filters without client identity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { items: [], has_more: false, next_cursor: null }, error: null });
    const client = { rpc } as never;

    await loadActivityFeedPage({
      organizationId: "org-primary",
      limit: 500,
      search: "Vansh",
      actorUserId: "5de0d03c-8756-4a37-897a-57aa0edcfd66",
      category: "inventory",
      fromDate: "2026-09-05",
      timeFrom: "15:30"
    }, client);

    expect(rpc).toHaveBeenCalledWith("list_activity_events", {
      payload: expect.objectContaining({
        organization_id: "org-primary",
        limit: 100,
        search: "Vansh",
        category: "inventory",
        from_date: "2026-09-05",
        time_from: "15:30"
      })
    });
    expect(rpc.mock.calls[0][1].payload).not.toHaveProperty("requesting_user_id");
  });

  it("supports filtered cursor pagination in local fallback mode", () => {
    const local = buildLocalActivityEvents([
      { id: "a3", action: "bill_issued", entityType: "bill", entityId: "b3", message: "Issued Vansh bill", createdAt: "2026-09-06T12:00:00Z", userId: "u1" },
      { id: "a2", action: "item_added", entityType: "session", entityId: "s2", message: "Added Herbal Flavour", createdAt: "2026-09-06T11:00:00Z", userId: "u2" },
      { id: "a1", action: "bill_issued", entityType: "bill", entityId: "b1", message: "Issued Naman bill", createdAt: "2026-09-05T10:00:00Z", userId: "u1" }
    ], [
      { id: "u1", name: "Vipin", username: "vipin", role: "admin", active: true },
      { id: "u2", name: "Reception", username: "desk", role: "receptionist", active: true }
    ]);

    const first = queryLocalActivityFeed(local, { search: "bill", category: "billing", limit: 1 });
    const second = queryLocalActivityFeed(local, { search: "bill", category: "billing", limit: 1, cursor: first.nextCursor });

    expect(first.items.map((entry) => entry.id)).toEqual(["a3"]);
    expect(first.hasMore).toBe(true);
    expect(second.items.map((entry) => entry.id)).toEqual(["a1"]);
    expect(second.hasMore).toBe(false);
    expect(second.actors.map((actor) => actor.userId)).toEqual(["u2", "u1"]);
  });

  it("supports cross-midnight time filters in local fallback mode", () => {
    const local = buildLocalActivityEvents([
      { id: "late", action: "session_started", entityType: "session", entityId: "s1", message: "Late", createdAt: "2026-09-06T18:00:00Z", userId: "u1" },
      { id: "early", action: "session_ended", entityType: "session", entityId: "s2", message: "Early", createdAt: "2026-09-06T23:30:00Z", userId: "u1" },
      { id: "day", action: "session_paused", entityType: "session", entityId: "s3", message: "Day", createdAt: "2026-09-06T07:00:00Z", userId: "u1" }
    ], [{ id: "u1", name: "Vipin", username: "vipin", role: "admin", active: true }]);

    const page = queryLocalActivityFeed(local, { timeFrom: "22:00", timeTo: "06:00" });

    expect(page.items.map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("fails closed instead of restarting when a local cursor is missing", () => {
    const local = buildLocalActivityEvents([
      { id: "a1", action: "bill_issued", entityType: "bill", entityId: "b1", message: "Issued bill", createdAt: "2026-09-06T12:00:00Z", userId: "u1" }
    ], [{ id: "u1", name: "Vipin", username: "vipin", role: "admin", active: true }]);

    const page = queryLocalActivityFeed(local, {
      cursor: { occurredAt: "2026-09-06T11:00:00Z", id: "missing" }
    });

    expect(page).toEqual({ items: [], actors: [], hasMore: false, nextCursor: null });
  });
});
