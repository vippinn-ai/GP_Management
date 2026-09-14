import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAppDataSnapshot } from "../backend";
import type { AppData } from "../types";

const backendMocks = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  loadRemoteAppStateMetadata: vi.fn(),
  loadRemoteAppDataSnapshot: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn(),
  getSupabaseClient: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

const normalizedReadMocks = vi.hoisted(() => ({
  buildOperationalBootstrapRpcResult: vi.fn(),
  loadNormalizedAppDataOverlay: vi.fn(),
  loadNormalizedAuditLogs: vi.fn(),
  loadNormalizedExpenseAdminData: vi.fn(),
  loadNormalizedStockMovements: vi.fn(),
  loadNormalizedStockMovementsByIds: vi.fn(),
  loadNormalizedAuditLogsByIds: vi.fn(),
  loadNormalizedLiveDataByIds: vi.fn()
}));

vi.mock("./normalizedReads", () => normalizedReadMocks);

const normalizedCustomerMocks = vi.hoisted(() => ({
  loadNormalizedCustomerDirectory: vi.fn(),
  loadNormalizedCustomersByIds: vi.fn()
}));

vi.mock("./normalizedCustomerSearch", () => normalizedCustomerMocks);

const normalizedBillRegisterMocks = vi.hoisted(() => ({
  getBusinessDayIssuedAtRange: vi.fn(() => ({
    fromIso: "2026-06-01T01:30:00.000Z",
    toIsoExclusive: "2026-07-01T01:30:00.000Z"
  })),
  loadNormalizedBillRegisterPage: vi.fn(),
  loadNormalizedBillsByIds: vi.fn(),
  loadNormalizedPendingBills: vi.fn(),
  resolveNormalizedBillRegisterOrganizationId: vi.fn()
}));

vi.mock("./normalizedBillRegister", () => normalizedBillRegisterMocks);

const normalizedReportMocks = vi.hoisted(() => ({
  loadNormalizedReportData: vi.fn()
}));

vi.mock("./normalizedReports", () => normalizedReportMocks);

const adminDataRpcMocks = vi.hoisted(() => ({
  invokeAdminDataChangeRpc: vi.fn()
}));

vi.mock("./adminDataRpcClient", () => adminDataRpcMocks);

import {
  DEFAULT_BACKEND_FEATURE_FLAGS,
  appStateRemoteDataGateway,
  createRemoteDataGateway,
  resolveBackendFeatureFlags
} from ".";
import {
  buildRetainedNoncriticalDataOverlay,
  loadDeferredNormalizedDashboardActivity,
  loadDeferredNormalizedDashboardContext,
  loadDeferredNormalizedDashboardHistory,
  loadNormalizedBillPages,
  loadNormalizedBootstrapStockMovements,
  mergeNormalizedAppDataOverlay
} from "./normalizedGateway";

function createAppData(): AppData {
  return {
    users: [],
    businessProfile: {
      name: "Test",
      logoText: "",
      address: "",
      primaryPhone: "",
      receiptFooter: ""
    },
    inventoryCategories: [],
    stations: [],
    pricingRules: [],
    sessions: [],
    sessionPauseLogs: [],
    customers: [],
    customerTabs: [],
    inventoryItems: [],
    combos: [],
    stockMovements: [],
    bills: [],
    payments: [],
    auditLogs: [],
    expenses: [],
    expenseTemplates: [],
    expenseTemplateOverrides: []
  };
}

describe("normalized overlay collection merging", () => {
  it("never lets retained client rows overwrite a slice refreshed from realtime", () => {
    const current = createAppData();
    current.bills = [{ id: "bill-1", billNumber: "OLD" } as never];
    current.payments = [{ id: "payment-1", amount: 10 } as never];
    current.customers = [{ id: "customer-1", name: "Old", createdAt: "2026-01-01T00:00:00.000Z", lastVisitAt: "2026-01-01T00:00:00.000Z" }];
    current.auditLogs = [{ id: "audit-1", action: "old", entityType: "bill", entityId: "bill-1", message: "old", createdAt: "2026-01-01T00:00:00.000Z", userId: "user-1" }];

    const canonical = createAppData();
    canonical.bills = [{ id: "bill-1", billNumber: "CANONICAL" } as never];
    canonical.payments = [{ id: "payment-1", amount: 20 } as never];
    canonical.customers = [{ ...current.customers[0], name: "Canonical" }];
    canonical.auditLogs = [{ ...current.auditLogs[0], action: "canonical", message: "canonical" }];

    const retained = buildRetainedNoncriticalDataOverlay(current, ["bills", "customers", "audit_logs"]);
    const merged = mergeNormalizedAppDataOverlay(canonical, retained);

    expect(retained).not.toHaveProperty("bills");
    expect(retained).not.toHaveProperty("payments");
    expect(retained).not.toHaveProperty("customers");
    expect(retained).not.toHaveProperty("auditLogs");
    expect(merged.bills[0].billNumber).toBe("CANONICAL");
    expect(merged.payments[0].amount).toBe(20);
    expect(merged.customers[0].name).toBe("Canonical");
    expect(merged.auditLogs[0].action).toBe("canonical");
  });

  it("merges changed customers, stock movements, and audits by ID without collapsing history", () => {
    const base = createAppData();
    base.customers = [
      { id: "customer-old", name: "Old", createdAt: "2026-01-01T00:00:00.000Z", lastVisitAt: "2026-01-01T00:00:00.000Z" },
      { id: "customer-change", name: "Before", createdAt: "2026-01-01T00:00:00.000Z", lastVisitAt: "2026-01-01T00:00:00.000Z" }
    ];
    base.stockMovements = [
      { id: "stock-old", itemId: "item-1", type: "sale", quantity: -1, reason: "old", createdAt: "2026-01-01T00:00:00.000Z", userId: "user-1" },
      { id: "stock-change", itemId: "item-1", type: "sale", quantity: -1, reason: "before", createdAt: "2026-01-01T00:00:00.000Z", userId: "user-1" }
    ];
    base.auditLogs = [
      { id: "audit-old", action: "old", entityType: "bill", entityId: "bill-old", message: "old", createdAt: "2026-01-01T00:00:00.000Z", userId: "user-1" },
      { id: "audit-change", action: "before", entityType: "bill", entityId: "bill-1", message: "before", createdAt: "2026-01-01T00:00:00.000Z", userId: "user-1" }
    ];

    const merged = mergeNormalizedAppDataOverlay(base, {
      customers: [{ ...base.customers[1], name: "After" }],
      stockMovements: [{ ...base.stockMovements[1], reason: "after" }],
      auditLogs: [{ ...base.auditLogs[1], action: "after", message: "after" }]
    });

    expect(merged.customers).toHaveLength(2);
    expect(merged.customers.find((entry) => entry.id === "customer-old")).toBeDefined();
    expect(merged.customers.find((entry) => entry.id === "customer-change")?.name).toBe("After");
    expect(merged.stockMovements).toHaveLength(2);
    expect(merged.stockMovements.find((entry) => entry.id === "stock-old")).toBeDefined();
    expect(merged.stockMovements.find((entry) => entry.id === "stock-change")?.reason).toBe("after");
    expect(merged.auditLogs).toHaveLength(2);
    expect(merged.auditLogs.find((entry) => entry.id === "audit-old")).toBeDefined();
    expect(merged.auditLogs.find((entry) => entry.id === "audit-change")?.action).toBe("after");
  });

  it("replaces the complete pause-log set for each refreshed session", () => {
    const base = createAppData();
    base.sessions = [
      { id: "session-1", stationId: "station-1", status: "paused" } as never,
      { id: "session-2", stationId: "station-2", status: "active" } as never
    ];
    base.sessionPauseLogs = [
      { id: "pause-deleted", sessionId: "session-1", pausedAt: "2026-08-19T10:00:00.000Z" },
      { id: "pause-remaining", sessionId: "session-1", pausedAt: "2026-08-19T11:00:00.000Z" },
      { id: "pause-other", sessionId: "session-2", pausedAt: "2026-08-19T12:00:00.000Z" }
    ];

    const merged = mergeNormalizedAppDataOverlay(base, {
      sessions: [{ id: "session-1", stationId: "station-1", status: "active" } as never],
      sessionPauseLogs: [{ ...base.sessionPauseLogs[1], resumedAt: "2026-08-19T11:05:00.000Z" }]
    });

    expect(merged.sessionPauseLogs.map((entry) => entry.id).sort()).toEqual(["pause-other", "pause-remaining"]);
    expect(merged.sessionPauseLogs.find((entry) => entry.id === "pause-remaining")?.resumedAt)
      .toBe("2026-08-19T11:05:00.000Z");
  });

  it("lets an open normalized session replace a stale open base session on the same station", () => {
    const base = createAppData();
    base.sessions = [{
      id: "session-stale",
      stationId: "station-shared",
      status: "active"
    } as never];
    const merged = mergeNormalizedAppDataOverlay(base, {
      sessions: [{
        id: "session-current",
        stationId: "station-shared",
        status: "active"
      } as never],
      sessionPauseLogs: []
    });

    expect(merged.sessions.map((session) => session.id)).toEqual(["session-current"]);
  });

  it("accepts a canonical closed hop-to-billed transition without resurrecting a closed session", () => {
    const base = createAppData();
    base.sessions = [{
      id: "session-hop",
      stationId: "station-1",
      status: "closed",
      closeDisposition: "hopped"
    } as never];

    const billed = mergeNormalizedAppDataOverlay(base, {
      sessions: [{
        id: "session-hop",
        stationId: "station-1",
        status: "closed",
        closeDisposition: "billed",
        closedBillId: "bill-1"
      } as never]
    });

    expect(billed.sessions).toHaveLength(1);
    expect(billed.sessions[0]).toMatchObject({
      status: "closed",
      closeDisposition: "billed",
      closedBillId: "bill-1"
    });

    const staleOpen = mergeNormalizedAppDataOverlay(billed, {
      sessions: [{ id: "session-hop", stationId: "station-1", status: "active" } as never]
    });
    expect(staleOpen.sessions[0]).toMatchObject({
      status: "closed",
      closeDisposition: "billed",
      closedBillId: "bill-1"
    });
  });

  it("does not let an ID-scoped closed hop patch evict a newer active session on the same station", () => {
    const base = createAppData();
    const hopped = {
      id: "session-hop",
      stationId: "station-1",
      status: "closed",
      closeDisposition: "hopped"
    } as never;
    const activeContinuation = {
      id: "session-next",
      stationId: "station-1",
      status: "active",
      continuedFromSessionIds: ["session-hop"]
    } as never;
    base.sessions = [hopped, activeContinuation];

    const merged = mergeNormalizedAppDataOverlay(base, { sessions: [hopped] });

    expect(merged.sessions).toHaveLength(2);
    expect(merged.sessions.find((session) => session.id === "session-hop")).toMatchObject({
      status: "closed",
      closeDisposition: "hopped"
    });
    expect(merged.sessions.find((session) => session.id === "session-next")).toMatchObject({
      status: "active",
      continuedFromSessionIds: ["session-hop"]
    });
  });

  it("hydrates historical bill-register pages by ID without dropping bootstrap financial rows", () => {
    const base = createAppData();
    base.bills = [
      { id: "bill-current", billNumber: "BILL-CURRENT", amountPaid: 10 },
      { id: "bill-history", billNumber: "BILL-HISTORY", amountPaid: 0 }
    ] as never;
    base.payments = [
      { id: "payment-current", billId: "bill-current", amount: 10 },
      { id: "payment-history", billId: "bill-history", amount: 5 }
    ] as never;

    const merged = mergeNormalizedAppDataOverlay(base, {
      bills: [
        { id: "bill-history", billNumber: "BILL-HISTORY", amountPaid: 25 },
        { id: "bill-older", billNumber: "BILL-OLDER", amountPaid: 0 }
      ] as never,
      payments: [
        { id: "payment-history", billId: "bill-history", amount: 25 },
        { id: "payment-older", billId: "bill-older", amount: 0 }
      ] as never
    });

    expect(merged.bills.map((entry) => entry.id).sort()).toEqual(["bill-current", "bill-history", "bill-older"]);
    expect(merged.bills.find((entry) => entry.id === "bill-history")?.amountPaid).toBe(25);
    expect(merged.payments.map((entry) => entry.id).sort()).toEqual([
      "payment-current",
      "payment-history",
      "payment-older"
    ]);
    expect(merged.payments.find((entry) => entry.id === "payment-history")?.amount).toBe(25);
  });

  it("never resurrects a terminal session across fifty stale hydration and realtime orderings", () => {
    for (let index = 0; index < 50; index += 1) {
      const base = createAppData();
      const id = `session-overlap-${index}`;
      const stale = { id, stationId: `station-${index}`, status: "active" } as never;
      const terminal = {
        id,
        stationId: `station-${index}`,
        status: "closed",
        closeDisposition: index % 2 === 0 ? "hopped" : "billed",
        ...(index % 2 === 0 ? {} : { closedBillId: `bill-${index}` })
      } as never;
      base.sessions = [stale];
      const responseFirst = mergeNormalizedAppDataOverlay(
        mergeNormalizedAppDataOverlay(base, { sessions: [terminal] }),
        { sessions: [stale] }
      );
      const realtimeFirst = mergeNormalizedAppDataOverlay(
        mergeNormalizedAppDataOverlay(base, { sessions: [stale] }),
        { sessions: [terminal] }
      );
      expect(responseFirst.sessions).toEqual([expect.objectContaining({ id, status: "closed" })]);
      expect(realtimeFirst.sessions).toEqual([expect.objectContaining({ id, status: "closed" })]);
    }
  });
});

describe("normalized bootstrap completeness", () => {
  it("fails closed instead of returning a capped partial bill history", async () => {
    normalizedBillRegisterMocks.loadNormalizedBillRegisterPage.mockResolvedValue({
      bills: [
        { id: "bill-1", billNumber: "BILL-1" },
        { id: "bill-2", billNumber: "BILL-2" }
      ],
      payments: [],
      hasMore: true,
      nextCursor: { issuedAt: "2026-08-20T10:00:00.000Z", id: "bill-2" }
    });

    await expect(loadNormalizedBillPages({ organizationId: "org-primary" }, {} as never, 2))
      .rejects.toThrow(/refusing to return partial financial data/i);
  });

  it("fails closed when the bounded stock audit context may be truncated", async () => {
    normalizedReadMocks.loadNormalizedStockMovements.mockResolvedValue(
      Array.from({ length: 5_000 }, (_, index) => ({ id: `movement-${index}` }))
    );

    await expect(loadNormalizedBootstrapStockMovements("org-primary", {} as never))
      .rejects.toThrow(/refusing to return partial inventory audit data/i);
  });
});

function createSnapshot(version = 1): RemoteAppDataSnapshot {
  return {
    appData: createAppData(),
    version,
    source: "app_state"
  };
}

describe("data gateway feature flags", () => {
  it("defaults every normalized and RPC feature flag to disabled", () => {
    expect(DEFAULT_BACKEND_FEATURE_FLAGS).toEqual({
      atomicBootstrap: false,
      normalizedBootstrap: false,
      normalizedConfigReads: false,
      normalizedCatalogReads: false,
      normalizedComboReads: false,
      normalizedLiveReads: false,
      normalizedCustomerSearchReads: false,
      normalizedReportReads: false,
      analyticsSummaryReads: false,
      inventoryReportReads: false,
      normalizedBillHistoryReads: false,
      normalizedRealtime: false,
      rpcOperationalWrites: false,
      operationalRpcV2: false,
      rpcFinancialWrites: false,
      financialRpcV2: false,
      activityFeed: false
    });
  });

  it("resolves explicit env flags and lets caller overrides win", () => {
    const flags = resolveBackendFeatureFlags(
      { rpcFinancialWrites: true },
      {
        VITE_BACKEND_ATOMIC_BOOTSTRAP: "true",
        VITE_BACKEND_NORMALIZED_CONFIG_READS: "true",
        VITE_BACKEND_NORMALIZED_BOOTSTRAP: "true",
        VITE_BACKEND_NORMALIZED_CATALOG_READS: "0",
        VITE_BACKEND_NORMALIZED_COMBO_READS: "yes",
        VITE_BACKEND_NORMALIZED_LIVE_READS: "true",
        VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS: "on",
        VITE_BACKEND_NORMALIZED_REPORT_READS: "1",
        VITE_BACKEND_ANALYTICS_SUMMARY_READS: "true",
        VITE_BACKEND_INVENTORY_REPORT_READS: "true",
        VITE_BACKEND_NORMALIZED_BILL_HISTORY_READS: "true",
        VITE_BACKEND_NORMALIZED_REALTIME: "true",
        VITE_BACKEND_RPC_OPERATIONAL_WRITES: "true",
        VITE_BACKEND_OPERATIONAL_RPC_V2: "true",
        VITE_BACKEND_RPC_FINANCIAL_WRITES: "false",
        VITE_BACKEND_FINANCIAL_RPC_V2: "true",
        VITE_BACKEND_ACTIVITY_FEED: "true"
      }
    );

    expect(flags.normalizedConfigReads).toBe(true);
    expect(flags.atomicBootstrap).toBe(true);
    expect(flags.normalizedBootstrap).toBe(true);
    expect(flags.normalizedCatalogReads).toBe(false);
    expect(flags.normalizedComboReads).toBe(true);
    expect(flags.normalizedLiveReads).toBe(true);
    expect(flags.normalizedCustomerSearchReads).toBe(true);
    expect(flags.normalizedReportReads).toBe(true);
    expect(flags.analyticsSummaryReads).toBe(true);
    expect(flags.inventoryReportReads).toBe(true);
    expect(flags.normalizedBillHistoryReads).toBe(true);
    expect(flags.rpcFinancialWrites).toBe(true);
    expect(flags.operationalRpcV2).toBe(true);
    expect(flags.financialRpcV2).toBe(true);
    expect(flags.activityFeed).toBe(true);
  });

  it("fails closed when financial v2 is enabled before normalized source-of-truth prerequisites", () => {
    expect(() => resolveBackendFeatureFlags({}, {
      VITE_BACKEND_FINANCIAL_RPC_V2: "true",
      VITE_BACKEND_RPC_FINANCIAL_WRITES: "true"
    })).toThrow(/requires the normalized source-of-truth rollout first/i);
  });

  it("fails closed when operational v2 is enabled before normalized live and realtime prerequisites", () => {
    expect(() => resolveBackendFeatureFlags({}, {
      VITE_BACKEND_OPERATIONAL_RPC_V2: "true",
      VITE_BACKEND_RPC_OPERATIONAL_WRITES: "true"
    })).toThrow(/requires normalized lifecycle reads and realtime first/i);
  });

  it("fails closed when atomic bootstrap is enabled before normalized bootstrap and realtime", () => {
    expect(() => resolveBackendFeatureFlags({}, {
      VITE_BACKEND_ATOMIC_BOOTSTRAP: "true",
      VITE_BACKEND_NORMALIZED_BOOTSTRAP: "true"
    })).toThrow(/requires normalized bootstrap and realtime first/i);
  });
});

describe("app_state data gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockResolvedValue({
      sessions: [],
      sessionPauseLogs: [],
      customerTabs: []
    });
    normalizedReadMocks.loadNormalizedExpenseAdminData.mockResolvedValue({
      expenses: [],
      expenseTemplates: [],
      expenseTemplateOverrides: []
    });
    normalizedReadMocks.loadNormalizedStockMovements.mockResolvedValue([]);
    normalizedReadMocks.loadNormalizedAuditLogs.mockResolvedValue([]);
    normalizedReadMocks.loadNormalizedStockMovementsByIds.mockResolvedValue([]);
    normalizedReadMocks.loadNormalizedAuditLogsByIds.mockResolvedValue([]);
    normalizedCustomerMocks.loadNormalizedCustomerDirectory.mockResolvedValue([]);
    normalizedCustomerMocks.loadNormalizedCustomersByIds.mockResolvedValue([]);
    normalizedBillRegisterMocks.loadNormalizedBillRegisterPage.mockResolvedValue({
      bills: [],
      payments: [],
      hasMore: false
    });
    normalizedBillRegisterMocks.loadNormalizedPendingBills.mockResolvedValue([]);
    normalizedReportMocks.loadNormalizedReportData.mockResolvedValue({
      bills: [],
      payments: [],
      expenses: [],
      billBusinessDates: {}
    });
  });

  it("delegates load, save, and realtime subscription to the existing backend functions", async () => {
    const appData = createAppData();
    const snapshot = createSnapshot(4);
    const telemetryOptions = { actionLabel: "Test save", source: "blocking" as const };
    const unsubscribe = vi.fn();
    const onChange = vi.fn();

    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(snapshot);
    backendMocks.saveRemoteAppData.mockResolvedValue(5);
    backendMocks.subscribeToRemoteAppData.mockReturnValue(unsubscribe);

    await expect(appStateRemoteDataGateway.loadAppDataSnapshot()).resolves.toBe(snapshot);
    await expect(appStateRemoteDataGateway.saveAppData(appData, "user-1", 4, telemetryOptions)).resolves.toBe(5);
    expect(appStateRemoteDataGateway.subscribeToAppData(onChange)).toBe(unsubscribe);

    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(backendMocks.saveRemoteAppData).toHaveBeenCalledWith(appData, "user-1", 4, telemetryOptions);
    expect(backendMocks.subscribeToRemoteAppData).toHaveBeenCalledWith(onChange);
  });

  it("keeps the default gateway on app_state when all feature flags are disabled", () => {
    expect(createRemoteDataGateway(DEFAULT_BACKEND_FEATURE_FLAGS)).toBe(appStateRemoteDataGateway);
  });

  it("overlays normalized catalog reads on top of the current snapshot when the catalog flag is enabled", async () => {
    const appData = createAppData();
    const normalizedItem = {
      id: "item-1",
      name: "Normalized Coke",
      category: "Beverage",
      price: 40,
      stockQty: 10,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      active: true
    };
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue({ appData, version: 7 });
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({
      organizationId: "org-primary",
      appData: {
        inventoryItems: [normalizedItem]
      }
    });

    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedCatalogReads: true
    });

    await expect(gateway.loadAppDataSnapshot()).resolves.toEqual({
      appData: {
        ...appData,
        inventoryItems: [normalizedItem]
      },
      version: 7
    });
    expect(normalizedReadMocks.loadNormalizedAppDataOverlay).toHaveBeenCalledWith({
      normalizedConfigReads: false,
      normalizedCatalogReads: true,
      normalizedComboReads: false,
      normalizedLiveReads: false
    });
  });

  it("overlays normalized combo reads independently from catalog reads", async () => {
    const appData = createAppData();
    const normalizedCombo = {
      id: "combo-1",
      name: "Momo Combo",
      type: "consumables" as const,
      active: true,
      stationIds: [],
      price: 199,
      includedMinutes: 0,
      fixedItems: [{ id: "fixed-1", sellableOptionId: "momo-plate", quantity: 2 }],
      choiceGroups: [],
      createdAt: "2026-06-20T10:00:00.000Z",
      updatedAt: "2026-06-20T10:00:00.000Z"
    };
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue({ appData, version: 8 });
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({
      organizationId: "org-primary",
      appData: {
        combos: [normalizedCombo]
      }
    });

    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedComboReads: true
    });

    await expect(gateway.loadAppDataSnapshot()).resolves.toEqual({
      appData: {
        ...appData,
        combos: [normalizedCombo]
      },
      version: 8
    });
    expect(normalizedReadMocks.loadNormalizedAppDataOverlay).toHaveBeenCalledWith({
      normalizedConfigReads: false,
      normalizedCatalogReads: false,
      normalizedComboReads: true,
      normalizedLiveReads: false
    });
  });

  it("overlays normalized live sessions and tabs while preserving closed history", async () => {
    const appData = createAppData();
    appData.sessions = [
      {
        id: "closed-session",
        stationId: "pool-2",
        stationNameSnapshot: "Pool 2",
        mode: "timed",
        startedAt: "2026-06-20T08:00:00.000Z",
        endedAt: "2026-06-20T09:00:00.000Z",
        status: "closed",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        items: [],
        pauseLogIds: [],
        closeDisposition: "hopped"
      },
      {
        id: "stale-open-session",
        stationId: "pool-1",
        stationNameSnapshot: "Pool 1",
        mode: "timed",
        startedAt: "2026-06-20T09:00:00.000Z",
        status: "active",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        items: [],
        pauseLogIds: ["stale-pause"]
      }
    ];
    appData.sessionPauseLogs = [
      {
        id: "stale-pause",
        sessionId: "stale-open-session",
        pausedAt: "2026-06-20T09:30:00.000Z"
      }
    ];
    appData.customerTabs = [
      {
        id: "closed-tab",
        customerName: "Old Customer",
        status: "closed",
        createdAt: "2026-06-20T08:00:00.000Z",
        closedAt: "2026-06-20T09:00:00.000Z",
        items: [],
        closedBillId: "bill-2"
      }
    ];
    const normalizedSession = {
      id: "normalized-open-session",
      stationId: "pool-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed" as const,
      startedAt: "2026-06-20T10:00:00.000Z",
      status: "active" as const,
      playMode: "group" as const,
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      pauseLogIds: ["normalized-pause"]
    };
    const staleNormalizedClosedSession = {
      id: "closed-session",
      stationId: "pool-2",
      stationNameSnapshot: "Pool 2",
      mode: "timed" as const,
      startedAt: "2026-06-20T08:00:00.000Z",
      status: "active" as const,
      playMode: "group" as const,
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      pauseLogIds: []
    };
    const normalizedPauseLog = {
      id: "normalized-pause",
      sessionId: "normalized-open-session",
      pausedAt: "2026-06-20T10:10:00.000Z"
    };
    const normalizedTab = {
      id: "open-tab",
      customerName: "Live Customer",
      status: "open" as const,
      createdAt: "2026-06-20T10:00:00.000Z",
      items: []
    };
    const staleNormalizedClosedTab = {
      id: "closed-tab",
      customerName: "Old Customer",
      status: "open" as const,
      createdAt: "2026-06-20T08:00:00.000Z",
      items: []
    };
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue({ appData, version: 9 });
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({
      organizationId: "org-primary",
      appData: {
        sessions: [normalizedSession, staleNormalizedClosedSession],
        sessionPauseLogs: [normalizedPauseLog],
        customerTabs: [normalizedTab, staleNormalizedClosedTab]
      }
    });

    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedLiveReads: true
    });

    await expect(gateway.loadAppDataSnapshot()).resolves.toMatchObject({
      version: 9,
      appData: {
        sessions: [appData.sessions[0], normalizedSession],
        sessionPauseLogs: [normalizedPauseLog],
        customerTabs: [appData.customerTabs[0], normalizedTab]
      }
    });
    expect(normalizedReadMocks.loadNormalizedAppDataOverlay).toHaveBeenCalledWith({
      normalizedConfigReads: false,
      normalizedCatalogReads: false,
      normalizedComboReads: false,
      normalizedLiveReads: true
    });
  });

  it("loads startup state from normalized tables without downloading full app_state data when bootstrap is enabled", async () => {
    const client = { from: vi.fn() };
    const profile = {
      id: "user-1",
      name: "QA Admin",
      username: "qa_admin",
      role: "admin" as const,
      active: true
    };
    const normalizedItem = {
      id: "item-1",
      name: "Normalized Momo",
      category: "Food",
      price: 80,
      stockQty: 12,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      active: true
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.fetchProfiles.mockResolvedValue([profile]);
    backendMocks.loadRemoteAppStateMetadata.mockResolvedValue({ version: 44 });
    normalizedBillRegisterMocks.loadNormalizedBillRegisterPage.mockResolvedValueOnce({
      bills: [
        {
          id: "bill-recent",
          billNumber: "BILL-RECENT",
          status: "issued",
          issuedAt: "2026-06-24T10:00:00.000Z",
          customerId: "customer-1",
          customerName: "Recent Customer",
          amountDue: 0
        }
      ],
      payments: [{ id: "payment-1", billId: "bill-recent", mode: "cash", amount: 80 }],
      hasMore: false
    });
    normalizedBillRegisterMocks.loadNormalizedPendingBills.mockResolvedValue([
      {
        id: "bill-pending",
        billNumber: "BILL-PENDING",
        status: "pending",
        issuedAt: "2026-06-23T10:00:00.000Z",
        customerId: "customer-2",
        customerName: "Pending Customer",
        amountDue: 50
      }
    ]);
    normalizedReportMocks.loadNormalizedReportData.mockResolvedValue({
      bills: [
        {
          id: "bill-paid-today",
          billNumber: "BILL-OLDER-PAID-TODAY",
          status: "pending",
          issuedAt: "2026-05-17T10:00:00.000Z",
          customerId: "customer-3",
          customerName: "Older Customer",
          amountDue: 119
        }
      ],
      payments: [
        {
          id: "payment-today-older-bill",
          billId: "bill-paid-today",
          mode: "cash",
          amount: 30,
          paidAt: "2026-06-24T10:30:00.000Z"
        }
      ],
      expenses: [{ id: "expense-1", title: "Milk", category: "Food", amount: 120 }],
      billBusinessDates: { "bill-paid-today": "2026-05-17" }
    });
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({
      organizationId: "org-primary",
      appData: {
        businessProfile: {
          name: "BreakPerfect",
          logoText: "",
          address: "",
          primaryPhone: "",
          receiptFooter: ""
        },
        inventoryCategories: ["Food"],
        inventoryItems: [normalizedItem],
        sessions: [],
        sessionPauseLogs: [],
        customerTabs: []
      }
    });
    normalizedReadMocks.loadNormalizedExpenseAdminData.mockResolvedValue({
      expenses: [{ id: "expense-1", title: "Milk", category: "Food", amount: 120 }],
      expenseTemplates: [{ id: "template-1", title: "Rent", category: "Rent", amount: 1000 }],
      expenseTemplateOverrides: [{ id: "override-1", templateId: "template-1", monthKey: "2026-06", amount: null }]
    });
    normalizedReadMocks.loadNormalizedStockMovements.mockResolvedValue([
      {
        id: "movement-1",
        itemId: "item-1",
        type: "sale",
        quantity: -2,
        reason: "Sold",
        createdAt: "2026-06-24T10:00:00.000Z",
        userId: "user-1"
      }
    ]);
    normalizedReadMocks.loadNormalizedAuditLogs.mockResolvedValue([
      {
        id: "audit-1",
        action: "bill_issued",
        entityType: "bill",
        entityId: "bill-recent",
        message: "Issued recent bill.",
        createdAt: "2026-06-24T10:01:00.000Z",
        userId: "user-1"
      }
    ]);

    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: true
    });

    await expect(gateway.loadAppDataSnapshot()).resolves.toMatchObject({
      version: 44,
      source: "normalized_bootstrap",
      appData: {
        users: [profile],
        businessProfile: { name: "BreakPerfect" },
        inventoryCategories: ["Food"],
        inventoryItems: [normalizedItem],
        bills: [],
        payments: [],
        customers: [],
        expenses: [],
        expenseTemplates: [],
        expenseTemplateOverrides: [],
        stockMovements: [],
        auditLogs: []
      }
    });
    expect(backendMocks.loadRemoteAppDataSnapshot).not.toHaveBeenCalled();
    expect(backendMocks.loadRemoteAppStateMetadata).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedAppDataOverlay).toHaveBeenCalledWith({
      normalizedConfigReads: true,
      normalizedCatalogReads: true,
      normalizedComboReads: true,
      normalizedLiveReads: true,
      client
    });
    expect(normalizedBillRegisterMocks.loadNormalizedBillRegisterPage).not.toHaveBeenCalled();
    expect(normalizedBillRegisterMocks.loadNormalizedPendingBills).not.toHaveBeenCalled();
    expect(normalizedReportMocks.loadNormalizedReportData).not.toHaveBeenCalled();
    expect(normalizedReadMocks.loadNormalizedAuditLogs).not.toHaveBeenCalled();

    await expect(loadDeferredNormalizedDashboardContext("org-primary")).resolves.toMatchObject({
      bills: expect.arrayContaining([
        expect.objectContaining({ id: "bill-pending", customerName: "Pending Customer" }),
        expect.objectContaining({ id: "bill-recent", customerName: "Recent Customer" }),
        expect.objectContaining({ id: "bill-paid-today", customerName: "Older Customer" })
      ]),
      payments: expect.arrayContaining([
        expect.objectContaining({ id: "payment-1" }),
        expect.objectContaining({ id: "payment-today-older-bill", billId: "bill-paid-today" })
      ]),
      expenses: [expect.objectContaining({ id: "expense-1", title: "Milk" })],
      auditLogs: [expect.objectContaining({ id: "audit-1", message: "Issued recent bill." })]
    });
    expect(normalizedBillRegisterMocks.loadNormalizedBillRegisterPage).toHaveBeenCalledTimes(1);
    expect(normalizedBillRegisterMocks.loadNormalizedBillRegisterPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        organizationId: "org-primary",
        businessDateFrom: expect.any(String),
        businessDateTo: expect.any(String),
        limit: 200
      }),
      client
    );
    expect(normalizedBillRegisterMocks.loadNormalizedPendingBills).toHaveBeenCalledWith({ organizationId: "org-primary" }, client);
    expect(normalizedReportMocks.loadNormalizedReportData).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-primary",
        fromDate: expect.any(String),
        toDate: expect.any(String)
      }),
      client
    );
    expect(normalizedReadMocks.loadNormalizedExpenseAdminData).not.toHaveBeenCalled();
    expect(normalizedReadMocks.loadNormalizedStockMovements).not.toHaveBeenCalled();
    expect(normalizedCustomerMocks.loadNormalizedCustomerDirectory).not.toHaveBeenCalled();
    expect(normalizedReadMocks.loadNormalizedAuditLogs).toHaveBeenCalledWith("org-primary", { limit: 20 }, client);
  });

  it("publishes recent Dashboard activity independently of slower financial history", async () => {
    let resolveBillPage!: (value: { bills: never[]; payments: never[]; hasMore: boolean }) => void;
    const delayedBillPage = new Promise<{ bills: never[]; payments: never[]; hasMore: boolean }>((resolve) => {
      resolveBillPage = resolve;
    });
    const client = { id: "client" };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedBillRegisterMocks.loadNormalizedBillRegisterPage.mockReturnValue(delayedBillPage);
    normalizedBillRegisterMocks.loadNormalizedPendingBills.mockResolvedValue([]);
    normalizedReportMocks.loadNormalizedReportData.mockResolvedValue({ bills: [], payments: [], expenses: [], billBusinessDates: {} });
    normalizedReadMocks.loadNormalizedAuditLogs.mockResolvedValue([{
      id: "audit-fast",
      action: "session_started",
      entityType: "session",
      entityId: "session-1",
      message: "Started session.",
      createdAt: "2026-09-14T10:00:00.000Z",
      userId: "user-1"
    }]);

    const history = loadDeferredNormalizedDashboardHistory("org-primary");
    let historySettled = false;
    void history.finally(() => { historySettled = true; });

    await expect(loadDeferredNormalizedDashboardActivity("org-primary")).resolves.toEqual({
      auditLogs: [expect.objectContaining({ id: "audit-fast" })]
    });
    expect(historySettled).toBe(false);

    resolveBillPage({ bills: [], payments: [], hasMore: false });
    await expect(history).resolves.toEqual({ bills: [], payments: [], expenses: [] });
  });

  it("blocks generic full app-state saves after normalized bootstrap is enabled", async () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: true
    });

    await expect(gateway.saveAppData(createAppData(), "user-1", 44)).rejects.toThrow(
      "Full app-state saves are disabled while normalized startup bootstrap is enabled"
    );
    expect(backendMocks.saveRemoteAppData).not.toHaveBeenCalled();
  });

  it("keeps RPC commit functions available when normalized bootstrap is enabled", () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: true,
      rpcOperationalWrites: true,
      rpcFinancialWrites: true
    });

    expect(gateway.commitOperationalMutation).toEqual(expect.any(Function));
    expect(gateway.commitFinancialCheckout).toEqual(expect.any(Function));
    expect(gateway.commitFinancialAdjustment).toEqual(expect.any(Function));
    expect(gateway.commitAdminDataChange).toEqual(expect.any(Function));
  });

  it("exposes admin data RPC commits when normalized bootstrap is enabled", async () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: true
    });
    const patch = {
      mutationId: "admin-change-1",
      entityType: "admin_data" as const,
      entityId: "Saving expense...",
      userId: "user-1",
      createdAt: "2026-06-25T10:00:00.000Z",
      baseAppStateVersion: 44,
      inventoryItems: [],
      inventoryItemIdsToDelete: [],
      combos: [],
      comboIdsToDelete: [],
      stockMovements: [],
      auditLogs: [],
      expenses: [],
      expenseIdsToDelete: [],
      expenseTemplates: [],
      expenseTemplateIdsToDelete: [],
      expenseTemplateOverrides: [],
      expenseTemplateOverrideIdsToDelete: [],
      stations: [],
      stationIdsToDelete: [],
      pricingRules: [],
      pricingRuleIdsToDelete: [],
      customers: [],
      customerIdsToDelete: []
    };
    adminDataRpcMocks.invokeAdminDataChangeRpc.mockResolvedValue({
      mutationId: patch.mutationId,
      rpcName: "commit_admin_data_change",
      organizationId: "org-primary",
      entityType: "admin_data",
      entityId: patch.entityId,
      appStateVersion: 45
    });

    await expect(gateway.commitAdminDataChange?.(patch)).resolves.toMatchObject({ appStateVersion: 45 });
    expect(adminDataRpcMocks.invokeAdminDataChangeRpc).toHaveBeenCalledWith(patch);
  });

  it("exposes admin data RPC commits when normalized realtime is enabled without normalized bootstrap", () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedBootstrap: false,
      normalizedRealtime: true
    });

    expect(gateway.commitAdminDataChange).toEqual(expect.any(Function));
  });

  it("keeps saves on app_state until RPC write flags are enabled", async () => {
    const appData = createAppData();
    backendMocks.saveRemoteAppData.mockResolvedValue(8);

    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedCatalogReads: true
    });

    await expect(gateway.saveAppData(appData, "user-1", 7)).resolves.toBe(8);
    expect(backendMocks.saveRemoteAppData).toHaveBeenCalledWith(appData, "user-1", 7, undefined);
  });

  it("exposes operational RPC commits while keeping non-operational saves on app_state", async () => {
    const appData = createAppData();
    backendMocks.saveRemoteAppData.mockResolvedValue(9);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      rpcOperationalWrites: true
    });

    expect(gateway.commitOperationalMutation).toEqual(expect.any(Function));
    await expect(gateway.saveAppData(appData, "user-1", 8)).resolves.toBe(9);
    expect(backendMocks.saveRemoteAppData).toHaveBeenCalledWith(appData, "user-1", 8, undefined);
  });

  it("exposes financial RPC commits while keeping generic saves on app_state", async () => {
    const appData = createAppData();
    backendMocks.saveRemoteAppData.mockResolvedValue(10);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      rpcFinancialWrites: true
    });

    expect(gateway.commitFinancialCheckout).toEqual(expect.any(Function));
    expect(gateway.commitFinancialAdjustment).toEqual(expect.any(Function));
    await expect(gateway.saveAppData(appData, "user-1", 9)).resolves.toBe(10);
    expect(backendMocks.saveRemoteAppData).toHaveBeenCalledWith(appData, "user-1", 9, undefined);
  });

  it("does not expose operational RPC commits unless the operational flag is enabled", () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedCatalogReads: true
    });

    expect(gateway.commitOperationalMutation).toBeUndefined();
  });

  it("subscribes to operational_events when normalized realtime is enabled", () => {
    const unsubscribe = vi.fn();
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: unsubscribe
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();

    const dispose = gateway.subscribeToAppData(onChange);

    expect(client.channel).toHaveBeenCalledWith("operational-events-sync");
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({
        event: "INSERT",
        schema: "public",
        table: "operational_events"
      }),
      expect.any(Function)
    );
    expect(backendMocks.subscribeToRemoteAppData).not.toHaveBeenCalled();
    dispose();
    expect(unsubscribe).toHaveBeenCalledWith(channel);
  });

  it("applies compact realtime live overlays without loading app_state after the initial snapshot", async () => {
    const baseSnapshot = createSnapshot(20);
    const normalizedTab = {
      id: "tab-1",
      customerName: "Realtime Customer",
      status: "open",
      createdAt: "2026-06-24T10:00:00.000Z",
      items: [],
      comboApplications: []
    };
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(baseSnapshot);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockResolvedValueOnce({
      sessions: [],
      sessionPauseLogs: [],
      customerTabs: [normalizedTab]
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();

    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-1",
        event_type: "open_customer_tab",
        entity_type: "customer_tab",
        entity_id: "tab-1",
        created_at: "2026-06-24T10:00:01.000Z",
        metadata: { app_state_version: 21, changed_rows: { customer_tabs: ["tab-1"] } }
      }
    });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toMatchObject({
      version: 21,
      sourceEventId: "event-1",
      appData: {
        customerTabs: [expect.objectContaining({ id: "tab-1", customerName: "Realtime Customer" })]
      }
    });
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedAppDataOverlay).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledWith(
      "org-primary",
      { sessionIds: [], customerTabIds: ["tab-1"] },
      client
    );
  });

  it("does not subscribe or invoke the atomic bootstrap RPC without an authenticated session", async () => {
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) },
      channel: vi.fn(),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    await expect(gateway.prepareAuthenticatedBootstrap?.()).resolves.toEqual({ status: "no-session" });
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).resolves.toEqual({ status: "no-session" });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.channel).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rechecks the session after a no-session preparation so a later sign-in can bootstrap", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        realtimeStatus = onStatus;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn()
        .mockResolvedValueOnce({ data: { session: null }, error: null })
        .mockResolvedValueOnce({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    await expect(gateway.prepareAuthenticatedBootstrap?.()).resolves.toEqual({ status: "no-session" });
    const signedInPreparation = gateway.prepareAuthenticatedBootstrap?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    realtimeStatus?.("SUBSCRIBED");

    await expect(signedInPreparation).resolves.toEqual({ status: "session", userId: "user-1" });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("reuses a failed atomic preparation until an explicit manual reset", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn(() => channel),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: {
        getSession: vi.fn()
          .mockRejectedValueOnce(new Error("Session lookup failed."))
          .mockResolvedValueOnce({ data: { session: { user: { id: "user-1" } } }, error: null })
      },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow("Session lookup failed.");
    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow("Session lookup failed.");
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);

    gateway.resetAuthenticatedBootstrapAttempt?.();
    const freshPreparation = gateway.prepareAuthenticatedBootstrap?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    realtimeStatus?.("SUBSCRIBED");
    await expect(freshPreparation).resolves.toEqual({ status: "session", userId: "user-1" });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it("shares one session, channel, buffer, and RPC across concurrent atomic bootstrap callers", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    let resolveRpc!: (value: { data: unknown; error: null }) => void;
    const rpcPromise = new Promise<{ data: unknown; error: null }>((resolve) => { resolveRpc = resolve; });
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        realtimeStatus = onStatus;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn(() => rpcPromise)
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 44,
      appData: createAppData()
    });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockResolvedValue({
      sessions: [{ id: "session-1", stationId: "station-1", status: "active" }],
      sessionPauseLogs: [],
      customerTabs: []
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const preparation = gateway.prepareAuthenticatedBootstrap?.();
    const firstLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    const secondLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    expect(client.rpc).not.toHaveBeenCalled();
    realtimeHandler?.({
      new: {
        organization_id: "org-other",
        id: "event-other",
        event_type: "start_session_v2",
        entity_type: "session",
        entity_id: "session-other",
        created_at: "2026-09-14T01:00:00.000Z",
        metadata: { changed_rows: { sessions: ["session-other"] } }
      }
    });
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-primary",
        event_type: "start_session_v2",
        entity_type: "session",
        entity_id: "session-1",
        created_at: "2026-09-14T01:00:01.000Z",
        metadata: { changed_rows: { sessions: ["session-1"] } }
      }
    });
    realtimeStatus?.("SUBSCRIBED");
    await expect(preparation).resolves.toEqual({ status: "session", userId: "user-1" });
    await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(1));
    resolveRpc({ data: { contract_version: 1 }, error: null });

    await expect(firstLoad).resolves.toMatchObject({
      status: "active",
      profile: { id: "user-1" },
      snapshot: {
        version: 44,
        sourceEventId: "event-primary",
        appData: { sessions: [expect.objectContaining({ id: "session-1" })] }
      }
    });
    await expect(secondLoad).resolves.toEqual(await firstLoad);
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("load_operational_bootstrap_v2");
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledWith(
      "org-primary",
      { sessionIds: ["session-1"], customerTabIds: [] },
      client
    );
  });

  it("replays buffered atomic events in order and suppresses duplicate event IDs", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: { actor: "user-1" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 44,
      appData: createAppData()
    });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockImplementation(async (
      _organizationId: string,
      ids: { sessionIds: string[]; customerTabIds: string[] }
    ) => ({
      sessions: ids.sessionIds.map((id) => ({ id, stationId: `station-${id}`, status: "active" })),
      sessionPauseLogs: [],
      customerTabs: []
    }));
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const loading = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeHandler).toBeTypeOf("function"));
    const event = (id: string, sessionId: string, createdAt: string) => ({
      organization_id: "org-primary",
      id,
      event_type: "session_updated",
      entity_type: "session",
      entity_id: sessionId,
      created_at: createdAt,
      metadata: { changed_rows: { sessions: [sessionId] } }
    });
    realtimeHandler?.({ new: event("event-1", "session-1", "2026-09-14T04:10:00.000Z") });
    realtimeHandler?.({ new: event("event-2", "session-2", "2026-09-14T04:10:01.000Z") });
    realtimeHandler?.({ new: event("event-1", "session-1", "2026-09-14T04:10:00.000Z") });
    realtimeStatus?.("SUBSCRIBED");

    await expect(loading).resolves.toMatchObject({
      status: "active",
      snapshot: {
        sourceEventId: "event-2",
        appData: { sessions: [expect.objectContaining({ id: "session-1" }), expect.objectContaining({ id: "session-2" })] }
      }
    });
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledTimes(2);
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds.mock.calls.map((call) => call[1].sessionIds)).toEqual([
      ["session-1"],
      ["session-2"]
    ]);
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the atomic pre-snapshot event buffer exceeds its bound", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const loading = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeHandler).toBeTypeOf("function"));
    for (let index = 0; index <= 1_000; index += 1) {
      realtimeHandler?.({
        new: {
          organization_id: "org-primary",
          id: `overflow-event-${index}`,
          event_type: "session_updated",
          entity_type: "session",
          entity_id: `session-${index}`,
          created_at: "2026-09-14T04:20:00.000Z",
          metadata: { changed_rows: { sessions: [`session-${index}`] } }
        }
      });
    }
    realtimeStatus?.("SUBSCRIBED");

    await expect(loading).rejects.toThrow("Normalized realtime bootstrap buffer exceeded its safe limit.");
    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow("Normalized realtime bootstrap buffer exceeded its safe limit.");
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).rejects.toThrow("Normalized realtime bootstrap buffer exceeded its safe limit.");
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("cannot publish a late account-A RPC after logout and an account-B bootstrap", async () => {
    const realtimeStatuses: Array<(status: string) => void> = [];
    let resolveAccountA!: (value: { data: unknown; error: null }) => void;
    const accountARpc = new Promise<{ data: unknown; error: null }>((resolve) => { resolveAccountA = resolve; });
    const client = {
      auth: {
        getSession: vi.fn()
          .mockResolvedValueOnce({ data: { session: { user: { id: "user-a" } } }, error: null })
          .mockResolvedValueOnce({ data: { session: { user: { id: "user-b" } } }, error: null })
      },
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn(() => channel),
          subscribe: vi.fn((callback: (status: string) => void) => {
            realtimeStatuses.push(callback);
            return channel;
          })
        };
        return channel;
      }),
      removeChannel: vi.fn(),
      rpc: vi.fn()
        .mockImplementationOnce(() => accountARpc)
        .mockResolvedValueOnce({ data: { actor: "user-b" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockImplementation((data: { actor?: string }) => {
      const actorId = data.actor ?? "user-a";
      return {
        status: "active",
        actorId,
        profile: { id: actorId, name: actorId, username: actorId, role: "admin", active: true },
        organization: { id: `org-${actorId}`, name: actorId, businessProfile: { name: actorId } },
        version: actorId === "user-a" ? 41 : 42,
        appData: createAppData()
      };
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const accountALoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    const accountARejected = expect(accountALoad).rejects.toThrow(/superseded by logout or account change/i);
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(1));
    realtimeStatuses[0]("SUBSCRIBED");
    await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(1));

    gateway.resetAuthenticatedBootstrapAttempt?.();
    const accountBLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(2));
    realtimeStatuses[1]("SUBSCRIBED");
    await expect(accountBLoad).resolves.toMatchObject({
      status: "active",
      profile: { id: "user-b" },
      organization: { id: "org-user-b" },
      snapshot: { version: 42 }
    });

    resolveAccountA({ data: { actor: "user-a" }, error: null });
    await accountARejected;
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).resolves.toEqual(await accountBLoad);
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("caches a post-ready atomic disconnect failure until one explicit manual reset", async () => {
    const realtimeStatuses: Array<(status: string) => void> = [];
    const channels = Array.from({ length: 2 }, () => {
      const channel = {
        on: vi.fn(() => channel),
        subscribe: vi.fn((callback: (status: string) => void) => {
          realtimeStatuses.push(callback);
          return channel;
        })
      };
      return channel;
    });
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn()
        .mockImplementationOnce(() => channels[0])
        .mockImplementationOnce(() => channels[1]),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: { actor: "user-1" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 44,
      appData: createAppData()
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const initialLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(1));
    realtimeStatuses[0]("SUBSCRIBED");
    await expect(initialLoad).resolves.toMatchObject({ status: "active", snapshot: { version: 44 } });
    const onError = vi.fn();
    const dispose = gateway.subscribeToAppData(vi.fn(), onError);

    realtimeStatuses[0]("CHANNEL_ERROR");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("manual retry") }));
    dispose();
    const remountError = vi.fn();
    gateway.subscribeToAppData(vi.fn(), remountError);
    await vi.waitFor(() => expect(remountError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("manual retry") })));
    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow(/manual retry/i);
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).rejects.toThrow(/manual retry/i);
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    gateway.resetAuthenticatedBootstrapAttempt?.();
    const freshLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(2));
    realtimeStatuses[1]("SUBSCRIBED");
    await expect(freshLoad).resolves.toMatchObject({ status: "active", snapshot: { version: 44 } });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps an atomic RPC failure across subscribe remounts until manual reset", async () => {
    const realtimeStatuses: Array<(status: string) => void> = [];
    const channels = Array.from({ length: 2 }, () => {
      const channel = {
        on: vi.fn(() => channel),
        subscribe: vi.fn((callback: (status: string) => void) => {
          realtimeStatuses.push(callback);
          return channel;
        })
      };
      return channel;
    });
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn()
        .mockImplementationOnce(() => channels[0])
        .mockImplementationOnce(() => channels[1]),
      removeChannel: vi.fn(),
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: null, error: new Error("Bootstrap RPC failed.") })
        .mockResolvedValueOnce({ data: { actor: "user-1" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 44,
      appData: createAppData()
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const failedLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(1));
    realtimeStatuses[0]("SUBSCRIBED");
    await expect(failedLoad).rejects.toThrow("Bootstrap RPC failed.");

    const firstError = vi.fn();
    const firstDispose = gateway.subscribeToAppData(vi.fn(), firstError);
    await vi.waitFor(() => expect(firstError).toHaveBeenCalledWith(expect.objectContaining({ message: "Bootstrap RPC failed." })));
    firstDispose();
    const remountError = vi.fn();
    gateway.subscribeToAppData(vi.fn(), remountError);
    await vi.waitFor(() => expect(remountError).toHaveBeenCalledWith(expect.objectContaining({ message: "Bootstrap RPC failed." })));
    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow("Bootstrap RPC failed.");
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).rejects.toThrow("Bootstrap RPC failed.");
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    gateway.resetAuthenticatedBootstrapAttempt?.();
    const freshLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(2));
    realtimeStatuses[1]("SUBSCRIBED");
    await expect(freshLoad).resolves.toMatchObject({ status: "active", snapshot: { version: 44 } });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not report a superseded account-A realtime hydration failure to account B", async () => {
    const realtimeHandlers: Array<(payload: { new: unknown }) => void> = [];
    const realtimeStatuses: Array<(status: string) => void> = [];
    let resolveAccountAOverlay!: (value: { sessions: never[]; sessionPauseLogs: never[]; customerTabs: never[] }) => void;
    const accountAOverlay = new Promise<{ sessions: never[]; sessionPauseLogs: never[]; customerTabs: never[] }>((resolve) => {
      resolveAccountAOverlay = resolve;
    });
    const client = {
      auth: {
        getSession: vi.fn()
          .mockResolvedValueOnce({ data: { session: { user: { id: "user-a" } } }, error: null })
          .mockResolvedValueOnce({ data: { session: { user: { id: "user-b" } } }, error: null })
      },
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
            realtimeHandlers.push(handler);
            return channel;
          }),
          subscribe: vi.fn((callback: (status: string) => void) => {
            realtimeStatuses.push(callback);
            return channel;
          })
        };
        return channel;
      }),
      removeChannel: vi.fn(),
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: { actor: "user-a" }, error: null })
        .mockResolvedValueOnce({ data: { actor: "user-b" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockImplementation((data: { actor: string }) => ({
      status: "active",
      actorId: data.actor,
      profile: { id: data.actor, name: data.actor, username: data.actor, role: "admin", active: true },
      organization: { id: `org-${data.actor}`, name: data.actor, businessProfile: { name: data.actor } },
      version: data.actor === "user-a" ? 41 : 42,
      appData: createAppData()
    }));
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockImplementationOnce(() => accountAOverlay);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const accountALoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(1));
    realtimeStatuses[0]("SUBSCRIBED");
    await expect(accountALoad).resolves.toMatchObject({ status: "active", profile: { id: "user-a" } });
    realtimeHandlers[0]({
      new: {
        organization_id: "org-user-a",
        id: "event-user-a",
        event_type: "session_updated",
        entity_type: "session",
        entity_id: "session-a",
        created_at: "2026-09-14T04:00:00.000Z",
        metadata: { changed_rows: { sessions: ["session-a"] } }
      }
    });
    await vi.waitFor(() => expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledTimes(1));

    gateway.resetAuthenticatedBootstrapAttempt?.();
    const accountBLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(2));
    realtimeStatuses[1]("SUBSCRIBED");
    await expect(accountBLoad).resolves.toMatchObject({ status: "active", profile: { id: "user-b" }, snapshot: { version: 42 } });
    const accountBChange = vi.fn();
    const accountBError = vi.fn();
    gateway.subscribeToAppData(accountBChange, accountBError);

    resolveAccountAOverlay({ sessions: [], sessionPauseLogs: [], customerTabs: [] });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(accountBChange).not.toHaveBeenCalled();
    expect(accountBError).not.toHaveBeenCalled();
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).resolves.toEqual(await accountBLoad);
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not deliver an old hydration failure to a same-callback remount", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    let rejectOverlay!: (error: Error) => void;
    const overlay = new Promise<never>((_resolve, reject) => {
      rejectOverlay = reject;
    });
    const channel = {
      on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: {}, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 41,
      appData: createAppData()
    });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockReturnValueOnce(overlay);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const initialLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    realtimeStatus?.("SUBSCRIBED");
    await expect(initialLoad).resolves.toMatchObject({ status: "active" });
    const sharedChange = vi.fn();
    const sharedError = vi.fn();
    const disposeFirst = gateway.subscribeToAppData(sharedChange, sharedError);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-old-listener",
        event_type: "session_updated",
        entity_type: "session",
        entity_id: "session-1",
        created_at: "2026-09-14T04:00:00.000Z",
        metadata: { changed_rows: { sessions: ["session-1"] } }
      }
    });
    await vi.waitFor(() => expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledTimes(1));

    disposeFirst();
    const disposeSecond = gateway.subscribeToAppData(sharedChange, sharedError);
    rejectOverlay(new Error("Old hydration failed."));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(sharedChange).not.toHaveBeenCalled();
    expect(sharedError).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledTimes(1);
    disposeSecond();
  });

  it("does not deliver an old hydration success to a same-callback remount", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    let resolveOldOverlay!: (value: { sessions: never[]; sessionPauseLogs: never[]; customerTabs: never[] }) => void;
    const oldOverlay = new Promise<{ sessions: never[]; sessionPauseLogs: never[]; customerTabs: never[] }>((resolve) => {
      resolveOldOverlay = resolve;
    });
    const channel = {
      on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: {}, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 41,
      appData: createAppData()
    });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockReturnValueOnce(oldOverlay).mockResolvedValue({
      sessions: [], sessionPauseLogs: [], customerTabs: []
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const initialLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    realtimeStatus?.("SUBSCRIBED");
    await expect(initialLoad).resolves.toMatchObject({ status: "active" });
    const sharedChange = vi.fn();
    const sharedError = vi.fn();
    const disposeFirst = gateway.subscribeToAppData(sharedChange, sharedError);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-old-success",
        event_type: "session_updated",
        entity_type: "session",
        entity_id: "session-old",
        created_at: "2026-09-14T04:00:00.000Z",
        metadata: { changed_rows: { sessions: ["session-old"] } }
      }
    });
    await vi.waitFor(() => expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledTimes(1));

    disposeFirst();
    const disposeSecond = gateway.subscribeToAppData(sharedChange, sharedError);
    resolveOldOverlay({ sessions: [], sessionPauseLogs: [], customerTabs: [] });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    expect(sharedChange).not.toHaveBeenCalled();
    expect(sharedError).not.toHaveBeenCalled();

    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-current-success",
        event_type: "session_updated",
        entity_type: "session",
        entity_id: "session-current",
        created_at: "2026-09-14T04:01:00.000Z",
        metadata: { changed_rows: { sessions: ["session-current"] } }
      }
    });
    await vi.waitFor(() => expect(sharedChange).toHaveBeenCalledTimes(1));
    expect(sharedError).not.toHaveBeenCalled();
    disposeSecond();
  });

  it("adopts delayed realtime readiness on a same-callback remount and only the current generation notifies", async () => {
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler: (payload: { new: unknown }) => void) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: {}, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 41,
      appData: createAppData()
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });
    const sharedChange = vi.fn();
    const sharedError = vi.fn();

    const disposeFirst = gateway.subscribeToAppData(sharedChange, sharedError);
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    disposeFirst();
    const disposeSecond = gateway.subscribeToAppData(sharedChange, sharedError);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    expect(client.removeChannel).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledTimes(1);
    const load = gateway.loadAuthenticatedAppDataSnapshot?.();
    realtimeStatus?.("SUBSCRIBED");
    await expect(load).resolves.toMatchObject({ status: "active", snapshot: { version: 41 } });
    expect(sharedChange).not.toHaveBeenCalled();
    expect(sharedError).not.toHaveBeenCalled();

    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-current-ready",
        event_type: "session_updated",
        entity_type: "session",
        entity_id: "session-current",
        created_at: "2026-09-14T04:02:00.000Z",
        metadata: { changed_rows: { sessions: ["session-current"] } }
      }
    });
    await vi.waitFor(() => expect(sharedChange).toHaveBeenCalledTimes(1));
    expect(sharedError).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledTimes(1);
    disposeSecond();
  });

  it("does not deliver an old delayed readiness failure to a same-callback remount", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((callback: (status: string) => void) => {
        realtimeStatus = callback;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });
    const sharedChange = vi.fn();
    const sharedError = vi.fn();

    const disposeFirst = gateway.subscribeToAppData(sharedChange, sharedError);
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    disposeFirst();
    const disposeSecond = gateway.subscribeToAppData(sharedChange, sharedError);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    expect(client.removeChannel).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledTimes(1);
    realtimeStatus?.("CHANNEL_ERROR");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    expect(sharedChange).not.toHaveBeenCalled();
    expect(sharedError).not.toHaveBeenCalled();
    await expect(gateway.prepareAuthenticatedBootstrap?.()).rejects.toThrow(/failed before bootstrap.*CHANNEL_ERROR/i);
    await expect(gateway.loadAuthenticatedAppDataSnapshot?.()).rejects.toThrow(/failed before bootstrap.*CHANNEL_ERROR/i);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.rpc).not.toHaveBeenCalled();
    disposeSecond();
  });

  it("tears down the atomic channel and returns no data for an inactive actor", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        realtimeStatus = onStatus;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: {}, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "inactive-or-missing",
      actorId: "user-1"
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const loading = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    realtimeStatus?.("SUBSCRIBED");
    await expect(loading).resolves.toEqual({ status: "inactive-or-missing", userId: "user-1" });
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("cancels a StrictMode-style deferred teardown when the next caller adopts the same preparation", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        realtimeStatus = onStatus;
        return channel;
      })
    };
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      rpc: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const first = gateway.prepareAuthenticatedBootstrap?.();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledTimes(1));
    gateway.scheduleAuthenticatedBootstrapCancellation?.();
    const adopted = gateway.prepareAuthenticatedBootstrap?.();
    realtimeStatus?.("SUBSCRIBED");

    await expect(first).resolves.toEqual({ status: "session", userId: "user-1" });
    await expect(adopted).resolves.toEqual({ status: "session", userId: "user-1" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    expect(client.auth.getSession).toHaveBeenCalledTimes(1);
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("rejects rather than hanging when an unadopted preparation is cancelled before SUBSCRIBED", async () => {
    const realtimeStatuses: Array<(status: string) => void> = [];
    const channels = Array.from({ length: 2 }, () => {
      const channel = {
        on: vi.fn(() => channel),
        subscribe: vi.fn((callback: (status: string) => void) => {
          realtimeStatuses.push(callback);
          return channel;
        })
      };
      return channel;
    });
    const client = {
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "user-1" } } }, error: null }) },
      channel: vi.fn()
        .mockImplementationOnce(() => channels[0])
        .mockImplementationOnce(() => channels[1]),
      removeChannel: vi.fn(),
      rpc: vi.fn().mockResolvedValue({ data: { actor: "user-1" }, error: null })
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    normalizedReadMocks.buildOperationalBootstrapRpcResult.mockReturnValue({
      status: "active",
      actorId: "user-1",
      profile: { id: "user-1", name: "Admin", username: "admin", role: "admin", active: true },
      organization: { id: "org-primary", name: "BreakPerfect", businessProfile: { name: "BreakPerfect" } },
      version: 44,
      appData: createAppData()
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      atomicBootstrap: true,
      normalizedBootstrap: true,
      normalizedRealtime: true
    });

    const preparation = gateway.prepareAuthenticatedBootstrap?.();
    const rejected = expect(preparation).rejects.toThrow("Normalized realtime preparation was superseded.");
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(1));
    gateway.scheduleAuthenticatedBootstrapCancellation?.();

    await rejected;
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(client.rpc).not.toHaveBeenCalled();

    const freshLoad = gateway.loadAuthenticatedAppDataSnapshot?.();
    await vi.waitFor(() => expect(realtimeStatuses).toHaveLength(2));
    realtimeStatuses[1]("SUBSCRIBED");
    await expect(freshLoad).resolves.toMatchObject({ status: "active", snapshot: { version: 44 } });
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });

  it("waits for confirmed realtime subscription before starting the bootstrap snapshot", async () => {
    let realtimeStatus: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        realtimeStatus = onStatus;
        return channel;
      })
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(createSnapshot(20));
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });

    const loading = gateway.loadAppDataSnapshot();
    await Promise.resolve();
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
    expect(backendMocks.loadRemoteAppDataSnapshot).not.toHaveBeenCalled();

    realtimeStatus?.("SUBSCRIBED");
    await expect(loading).resolves.toMatchObject({ version: 20 });
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
  });

  it("buffers compact events received during bootstrap and folds them into the returned snapshot", async () => {
    let resolveBase!: (snapshot: RemoteAppDataSnapshot) => void;
    const basePromise = new Promise<RemoteAppDataSnapshot>((resolve) => {
      resolveBase = resolve;
    });
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockReturnValue(basePromise);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockResolvedValueOnce({
      sessions: [{ id: "session-closed", stationId: "station-1", status: "closed", closeDisposition: "hopped" }],
      sessionPauseLogs: [],
      customerTabs: []
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();
    gateway.subscribeToAppData(onChange);
    const loading = gateway.loadAppDataSnapshot();

    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-during-bootstrap",
        event_type: "hop_session_v2",
        entity_type: "session",
        entity_id: "session-closed",
        created_at: "2026-09-12T10:00:00.000Z",
        metadata: { changed_rows: { sessions: ["session-closed"] } }
      }
    });
    resolveBase(createSnapshot(20));

    await expect(loading).resolves.toMatchObject({
      sourceEventId: "event-during-bootstrap",
      appData: {
        sessions: [expect.objectContaining({ id: "session-closed", closeDisposition: "hopped" })]
      }
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to app_state for a realtime full-refresh event", async () => {
    const baseSnapshot = createSnapshot(20);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValueOnce(baseSnapshot);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({ appData: {}, organizationId: "org-primary" });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();
    const onError = vi.fn();

    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange, onError);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-full-refresh",
        event_type: "app_state_saved",
        entity_type: "app_state",
        entity_id: "primary",
        created_at: "2026-09-06T14:00:00.000Z",
        metadata: { requires_full_refresh: true, app_state_version: 20 }
      }
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      "Unable to apply compact realtime event.",
      expect.objectContaining({ message: "A full-refresh event requires an explicit normalized restore." })
    ));
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "A full-refresh event requires an explicit normalized restore." }));
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("surfaces a post-ready realtime disconnect and creates a fresh subscription for recovery", async () => {
    const statusCallbacks: Array<(status: string) => void> = [];
    const channels = Array.from({ length: 2 }, () => {
      const channel = {
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn((onStatus?: (status: string) => void) => {
          if (onStatus) statusCallbacks.push(onStatus);
          return channel;
        })
      };
      return channel;
    });
    const client = { channel: vi.fn().mockReturnValueOnce(channels[0]).mockReturnValueOnce(channels[1]), removeChannel: vi.fn() };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(createSnapshot(20));
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValue({ appData: {}, organizationId: "org-primary" });
    const gateway = createRemoteDataGateway({ ...DEFAULT_BACKEND_FEATURE_FLAGS, normalizedRealtime: true });
    const onError = vi.fn();

    const initialLoad = gateway.loadAppDataSnapshot();
    await vi.waitFor(() => expect(statusCallbacks).toHaveLength(1));
    statusCallbacks[0]("SUBSCRIBED");
    await initialLoad;
    const dispose = gateway.subscribeToAppData(vi.fn(), onError);
    statusCallbacks[0]("CHANNEL_ERROR");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("fresh restore") }));

    const recovery = gateway.loadAppDataSnapshot();
    await vi.waitFor(() => expect(statusCallbacks).toHaveLength(2));
    statusCallbacks[1]("SUBSCRIBED");
    await expect(recovery).resolves.toMatchObject({ version: 20 });
    expect(client.channel).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("marks compact financial realtime snapshots so screen-specific bill readers refetch", async () => {
    const baseSnapshot = createSnapshot(40);
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(baseSnapshot);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    normalizedBillRegisterMocks.loadNormalizedBillsByIds.mockResolvedValueOnce({
      bills: [{ id: "bill-replacement", billNumber: "BILL-REPLACEMENT" }],
      payments: []
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();

    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-financial",
        event_type: "financial_adjustment",
        entity_type: "bill",
        entity_id: "bill-replacement",
        created_at: "2026-08-20T03:54:16.000Z",
        metadata: {
          mutation_id: "financial-adjustment-1",
          app_state_version: 41,
          changed_rows: { bills: ["bill-original", "bill-replacement"] }
        }
      }
    });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toMatchObject({
      version: 41,
      sourceMutationId: "financial-adjustment-1",
      sourceEventId: "event-financial",
      refreshedSlices: ["bills"],
      appData: {
        bills: [expect.objectContaining({ id: "bill-replacement" })]
      }
    });
    expect(normalizedBillRegisterMocks.loadNormalizedBillsByIds).toHaveBeenCalledWith(
      {
        organizationId: "org-primary",
        billIds: ["bill-original", "bill-replacement"],
        paymentIds: []
      },
      client
    );
  });

  it("removes a deleted customer when the canonical compact lookup returns no row", async () => {
    const baseSnapshot = createSnapshot(42);
    baseSnapshot.appData.customers.push({
      id: "customer-deleted",
      name: "Old profile",
      createdAt: "2026-09-01T08:00:00.000Z",
      lastVisitAt: "2026-09-01T08:00:00.000Z"
    });
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(baseSnapshot);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    normalizedCustomerMocks.loadNormalizedCustomersByIds.mockResolvedValueOnce([]);
    const gateway = createRemoteDataGateway({ ...DEFAULT_BACKEND_FEATURE_FLAGS, normalizedRealtime: true });
    const onChange = vi.fn();

    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-customer-delete",
        event_type: "admin_data_changed",
        entity_type: "customer",
        entity_id: "customer-deleted",
        created_at: "2026-09-12T08:00:00.000Z",
        metadata: { mutation_id: "delete-customer-1", changed_rows: { customers: ["customer-deleted"] } }
      }
    });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0].refreshedSlices).toContain("customers");
    expect(onChange.mock.calls[0][0].appData.customers).not.toContainEqual(
      expect.objectContaining({ id: "customer-deleted" })
    );
  });

  it("applies compact realtime changed session rows when a live event closes a session", async () => {
    const baseSnapshot = createSnapshot(30);
    baseSnapshot.appData.sessions.push({
      id: "session-1",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-24T09:00:00.000Z",
      status: "active",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      comboApplications: [],
      pauseLogIds: []
    });
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn((onStatus?: (status: string) => void) => {
        onStatus?.("SUBSCRIBED");
        return channel;
      })
    };
    const client = {
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    };
    backendMocks.getSupabaseClient.mockReturnValue(client);
    backendMocks.loadRemoteAppDataSnapshot.mockResolvedValue(baseSnapshot);
    normalizedReadMocks.loadNormalizedAppDataOverlay.mockResolvedValueOnce({ appData: {}, organizationId: "org-primary" });
    normalizedReadMocks.loadNormalizedLiveDataByIds.mockResolvedValueOnce({
      sessions: [{
        ...baseSnapshot.appData.sessions[0],
        status: "closed",
        endedAt: "2026-06-24T10:00:00.000Z",
        closeDisposition: "hopped"
      }],
      sessionPauseLogs: [],
      customerTabs: []
    });
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedRealtime: true
    });
    const onChange = vi.fn();

    await gateway.loadAppDataSnapshot();
    gateway.subscribeToAppData(onChange);
    realtimeHandler?.({
      new: {
        organization_id: "org-primary",
        id: "event-hop",
        event_type: "hop_session",
        entity_type: "session",
        entity_id: "session-1",
        created_at: "2026-06-24T10:00:01.000Z",
        metadata: { app_state_version: 31, changed_rows: { sessions: ["session-1"] } }
      }
    });

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0].appData.sessions[0]).toMatchObject({
      id: "session-1",
      status: "closed",
      closeDisposition: "hopped"
    });
    expect(backendMocks.loadRemoteAppDataSnapshot).toHaveBeenCalledTimes(1);
    expect(normalizedReadMocks.loadNormalizedLiveDataByIds).toHaveBeenCalledWith(
      "org-primary",
      { sessionIds: ["session-1"], customerTabIds: [] },
      client
    );
  });
});
