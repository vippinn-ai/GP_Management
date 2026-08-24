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
      rpcFinancialWrites: false,
      financialRpcV2: false
    });
  });

  it("resolves explicit env flags and lets caller overrides win", () => {
    const flags = resolveBackendFeatureFlags(
      { rpcFinancialWrites: true },
      {
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
        VITE_BACKEND_RPC_FINANCIAL_WRITES: "false",
        VITE_BACKEND_FINANCIAL_RPC_V2: "true"
      }
    );

    expect(flags.normalizedConfigReads).toBe(true);
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
    expect(flags.financialRpcV2).toBe(true);
  });

  it("fails closed when financial v2 is enabled before normalized source-of-truth prerequisites", () => {
    expect(() => resolveBackendFeatureFlags({}, {
      VITE_BACKEND_FINANCIAL_RPC_V2: "true",
      VITE_BACKEND_RPC_FINANCIAL_WRITES: "true"
    })).toThrow(/requires the normalized source-of-truth rollout first/i);
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
      expenses: [],
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
        bills: expect.arrayContaining([
          expect.objectContaining({ id: "bill-pending", customerName: "Pending Customer" }),
          expect.objectContaining({ id: "bill-recent", customerName: "Recent Customer" }),
          expect.objectContaining({ id: "bill-paid-today", customerName: "Older Customer" })
        ]),
        payments: expect.arrayContaining([
          expect.objectContaining({ id: "payment-1" }),
          expect.objectContaining({ id: "payment-today-older-bill", billId: "bill-paid-today" })
        ]),
        customers: [
          expect.objectContaining({ id: "customer-1", name: "Recent Customer" }),
          expect.objectContaining({ id: "customer-2", name: "Pending Customer" }),
          expect.objectContaining({ id: "customer-3", name: "Older Customer" })
        ],
        expenses: [expect.objectContaining({ id: "expense-1", title: "Milk" })],
        expenseTemplates: [expect.objectContaining({ id: "template-1", title: "Rent" })],
        expenseTemplateOverrides: [expect.objectContaining({ id: "override-1", templateId: "template-1" })],
        stockMovements: [expect.objectContaining({ id: "movement-1", itemId: "item-1" })],
        auditLogs: [expect.objectContaining({ id: "audit-1", message: "Issued recent bill." })]
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
    expect(normalizedReadMocks.loadNormalizedExpenseAdminData).toHaveBeenCalledWith("org-primary", client);
    expect(normalizedReadMocks.loadNormalizedStockMovements).toHaveBeenCalledWith(
      "org-primary",
      expect.objectContaining({ limit: 5000 }),
      client
    );
    expect(normalizedReadMocks.loadNormalizedAuditLogs).toHaveBeenCalledWith("org-primary", { limit: 20 }, client);
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
      subscribe: vi.fn().mockReturnThis()
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
      subscribe: vi.fn().mockReturnThis()
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

  it("marks compact financial realtime snapshots so screen-specific bill readers refetch", async () => {
    const baseSnapshot = createSnapshot(40);
    let realtimeHandler: ((payload: { new: unknown }) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, _config, handler) => {
        realtimeHandler = handler;
        return channel;
      }),
      subscribe: vi.fn().mockReturnThis()
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
      subscribe: vi.fn().mockReturnThis()
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
