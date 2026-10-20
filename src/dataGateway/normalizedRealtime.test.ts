import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalEventRow } from "./normalizedRealtime";

const mocks = vi.hoisted(() => ({
  broad: vi.fn(),
  live: vi.fn(),
  bills: vi.fn(),
  customers: vi.fn(),
  stock: vi.fn(),
  audits: vi.fn()
}));

vi.mock("./normalizedBillRegister", () => ({
  loadNormalizedBillsByIds: mocks.bills
}));
vi.mock("./normalizedCustomerSearch", () => ({
  loadNormalizedCustomersByIds: mocks.customers
}));
vi.mock("./normalizedReads", () => ({
  loadNormalizedAppDataOverlay: mocks.broad,
  loadNormalizedLiveDataByIds: mocks.live,
  loadNormalizedStockMovementsByIds: mocks.stock,
  loadNormalizedAuditLogsByIds: mocks.audits
}));

import { loadNormalizedRealtimeOverlay } from "./normalizedRealtime";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mixedEvent(overrides: Partial<OperationalEventRow> = {}): OperationalEventRow {
  return {
    organization_id: "org-primary",
    id: "event-1",
    event_type: "financial_checkout_committed",
    entity_type: "session",
    entity_id: "session-1",
    created_at: "2026-10-20T00:00:00.000Z",
    metadata: {
      mutation_id: "mutation-1",
      app_state_version: 735,
      changed_rows: {
        inventory_items: ["item-1"],
        combos: ["combo-1"],
        sessions: ["session-1"],
        customer_tabs: ["tab-1"],
        bills: ["bill-1"],
        payments: ["payment-1"],
        customers: ["customer-1", "customer-missing"],
        stock_movements: ["movement-1"],
        audit_logs: ["audit-1"]
      }
    },
    ...overrides
  };
}

function installResolvedDefaults(): void {
  mocks.broad.mockResolvedValue({ appData: {} });
  mocks.live.mockResolvedValue({ sessions: [], sessionPauseLogs: [], customerTabs: [] });
  mocks.bills.mockResolvedValue({ bills: [], payments: [] });
  mocks.customers.mockResolvedValue([]);
  mocks.stock.mockResolvedValue([]);
  mocks.audits.mockResolvedValue([]);
}

function installDeferredGroups() {
  const groups = {
    broad: deferred<unknown>(),
    live: deferred<unknown>(),
    bills: deferred<unknown>(),
    customers: deferred<unknown>(),
    stock: deferred<unknown>(),
    audits: deferred<unknown>()
  };
  mocks.broad.mockReturnValue(groups.broad.promise);
  mocks.live.mockReturnValue(groups.live.promise);
  mocks.bills.mockReturnValue(groups.bills.promise);
  mocks.customers.mockReturnValue(groups.customers.promise);
  mocks.stock.mockReturnValue(groups.stock.promise);
  mocks.audits.mockReturnValue(groups.audits.promise);
  return groups;
}

function resolveGroup(group: keyof ReturnType<typeof installDeferredGroups>, deferredGroup: Deferred<unknown>): void {
  const values = {
    broad: { appData: {} },
    live: { sessions: [], sessionPauseLogs: [], customerTabs: [] },
    bills: { bills: [], payments: [] },
    customers: [],
    stock: [],
    audits: []
  };
  deferredGroup.resolve(values[group]);
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
}

beforeEach(() => {
  vi.resetAllMocks();
  installResolvedDefaults();
});

describe("normalized realtime overlay read scheduling", () => {
  it("starts all six independent logical read groups before any group resolves", async () => {
    const groups = installDeferredGroups();
    const pending = loadNormalizedRealtimeOverlay(mixedEvent(), {} as never, {} as never);

    expect(mocks.broad).toHaveBeenCalledOnce();
    expect(mocks.live).toHaveBeenCalledOnce();
    expect(mocks.bills).toHaveBeenCalledOnce();
    expect(mocks.customers).toHaveBeenCalledOnce();
    expect(mocks.stock).toHaveBeenCalledOnce();
    expect(mocks.audits).toHaveBeenCalledOnce();
    await expectStillPending(pending);

    for (const [name, group] of Object.entries(groups).reverse()) {
      resolveGroup(name as keyof typeof groups, group);
    }
    await expect(pending).resolves.toMatchObject({ requiresFullRefresh: false });
  });

  it("assembles exact output and merge precedence independent of reverse completion order", async () => {
    const groups = installDeferredGroups();
    const pending = loadNormalizedRealtimeOverlay(mixedEvent(), {} as never, {} as never);

    groups.audits.resolve([{ id: "audit-1", action: "rejected" }]);
    groups.stock.resolve([{ id: "movement-1", quantityChange: -1 }]);
    groups.customers.resolve([{ id: "customer-1", name: "Current customer" }]);
    groups.bills.resolve({ bills: [{ id: "bill-1" }], payments: [{ id: "payment-1" }] });
    groups.live.resolve({
      sessions: [{ id: "session-2", status: "active" }, { id: "session-1", status: "closed" }],
      sessionPauseLogs: [{ id: "pause-1", sessionId: "session-1" }],
      customerTabs: [{ id: "tab-1", status: "closed" }]
    });
    groups.broad.resolve({
      appData: {
        inventoryItems: [{ id: "item-1", name: "Item" }],
        combos: [{ id: "combo-1", name: "Combo" }],
        sessions: [{ id: "session-1", status: "active" }],
        sessionPauseLogs: [{ id: "pause-old", sessionId: "session-1" }],
        customerTabs: [{ id: "tab-1", status: "active" }]
      }
    });

    await expect(pending).resolves.toEqual({
      appData: {
        inventoryItems: [{ id: "item-1", name: "Item" }],
        combos: [{ id: "combo-1", name: "Combo" }],
        sessions: [{ id: "session-2", status: "active" }, { id: "session-1", status: "closed" }],
        sessionPauseLogs: [
          { id: "pause-1", sessionId: "session-1" },
          { id: "pause-old", sessionId: "session-1" }
        ],
        customerTabs: [{ id: "tab-1", status: "closed" }],
        bills: [{ id: "bill-1" }],
        payments: [{ id: "payment-1" }],
        customers: [{ id: "customer-1", name: "Current customer" }],
        stockMovements: [{ id: "movement-1", quantityChange: -1 }],
        auditLogs: [{ id: "audit-1", action: "rejected" }]
      },
      refreshedSlices: [
        "catalog", "combos", "changed_live_rows", "bills", "customers", "stock_movements", "audit_logs"
      ],
      removedCustomerIds: ["customer-missing"],
      appStateVersion: 735,
      sourceMutationId: "mutation-1",
      requiresFullRefresh: false
    });
  });

  for (const failingGroup of ["broad", "live", "bills", "customers", "stock", "audits"] as const) {
    it(`drains sibling reads before propagating a ${failingGroup} failure`, async () => {
      const groups = installDeferredGroups();
      const failure = new Error(`${failingGroup} failed`);
      const pending = loadNormalizedRealtimeOverlay(mixedEvent(), {} as never, {} as never);

      groups[failingGroup].reject(failure);
      await expectStillPending(pending);
      for (const [name, group] of Object.entries(groups)) {
        if (name !== failingGroup) resolveGroup(name as keyof typeof groups, group);
      }
      await expect(pending).rejects.toBe(failure);
    });
  }

  it("propagates multiple failures in broad/live/bill/customer/stock/audit logical priority", async () => {
    const groups = installDeferredGroups();
    const pending = loadNormalizedRealtimeOverlay(mixedEvent(), {} as never, {} as never);

    const auditFailure = new Error("audit failed first");
    const billFailure = new Error("bill failed second");
    const broadFailure = new Error("broad failed last");
    groups.audits.reject(auditFailure);
    groups.bills.reject(billFailure);
    groups.broad.reject(broadFailure);
    resolveGroup("live", groups.live);
    resolveGroup("customers", groups.customers);
    resolveGroup("stock", groups.stock);

    await expect(pending).rejects.toBe(broadFailure);
  });

  it("returns full-refresh metadata without launching any normalized read", async () => {
    await expect(loadNormalizedRealtimeOverlay(mixedEvent({
      metadata: { mutation_id: "mutation-full", app_state_version: 736, requires_full_refresh: true }
    }), {} as never, {} as never)).resolves.toEqual({
      appData: {},
      refreshedSlices: ["full_app_state"],
      removedCustomerIds: [],
      appStateVersion: 736,
      sourceMutationId: "mutation-full",
      requiresFullRefresh: true
    });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("preserves empty-ID behavior without starting broad, live, or bill reads", async () => {
    const event = mixedEvent({
      event_type: "unknown_event",
      entity_type: "unknown_entity",
      entity_id: "unknown-1",
      metadata: { mutation_id: "mutation-empty", changed_rows: {} }
    });
    await expect(loadNormalizedRealtimeOverlay(event, {} as never, {} as never)).resolves.toEqual({
      appData: {},
      refreshedSlices: [],
      removedCustomerIds: [],
      sourceMutationId: "mutation-empty",
      requiresFullRefresh: false
    });
    expect(mocks.broad).not.toHaveBeenCalled();
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.bills).not.toHaveBeenCalled();
    expect(mocks.customers).toHaveBeenCalledWith("org-primary", [], expect.anything());
    expect(mocks.stock).toHaveBeenCalledWith("org-primary", [], expect.anything());
    expect(mocks.audits).toHaveBeenCalledWith("org-primary", [], expect.anything());
  });
});
