import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAppDataSnapshot } from "../backend";
import type { AppData } from "../types";

const backendMocks = vi.hoisted(() => ({
  loadRemoteAppDataSnapshot: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn(),
  getSupabaseClient: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

const normalizedReadMocks = vi.hoisted(() => ({
  loadNormalizedAppDataOverlay: vi.fn(),
  loadNormalizedLiveDataByIds: vi.fn()
}));

vi.mock("./normalizedReads", () => normalizedReadMocks);

import {
  DEFAULT_BACKEND_FEATURE_FLAGS,
  appStateRemoteDataGateway,
  createRemoteDataGateway,
  resolveBackendFeatureFlags
} from ".";

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

function createSnapshot(version = 1): RemoteAppDataSnapshot {
  return {
    appData: createAppData(),
    version
  };
}

describe("data gateway feature flags", () => {
  it("defaults every normalized and RPC feature flag to disabled", () => {
    expect(DEFAULT_BACKEND_FEATURE_FLAGS).toEqual({
      normalizedConfigReads: false,
      normalizedCatalogReads: false,
      normalizedComboReads: false,
      normalizedLiveReads: false,
      normalizedCustomerSearchReads: false,
      normalizedReportReads: false,
      normalizedBillHistoryReads: false,
      normalizedRealtime: false,
      rpcOperationalWrites: false,
      rpcFinancialWrites: false
    });
  });

  it("resolves explicit env flags and lets caller overrides win", () => {
    const flags = resolveBackendFeatureFlags(
      { rpcFinancialWrites: true },
      {
        VITE_BACKEND_NORMALIZED_CONFIG_READS: "true",
        VITE_BACKEND_NORMALIZED_CATALOG_READS: "0",
        VITE_BACKEND_NORMALIZED_COMBO_READS: "yes",
        VITE_BACKEND_NORMALIZED_LIVE_READS: "true",
        VITE_BACKEND_NORMALIZED_CUSTOMER_SEARCH_READS: "on",
        VITE_BACKEND_NORMALIZED_REPORT_READS: "1",
        VITE_BACKEND_RPC_FINANCIAL_WRITES: "false"
      }
    );

    expect(flags.normalizedConfigReads).toBe(true);
    expect(flags.normalizedCatalogReads).toBe(false);
    expect(flags.normalizedComboReads).toBe(true);
    expect(flags.normalizedLiveReads).toBe(true);
    expect(flags.normalizedCustomerSearchReads).toBe(true);
    expect(flags.normalizedReportReads).toBe(true);
    expect(flags.rpcFinancialWrites).toBe(true);
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
