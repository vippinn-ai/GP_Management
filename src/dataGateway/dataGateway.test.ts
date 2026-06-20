import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAppDataSnapshot } from "../backend";
import type { AppData } from "../types";

const backendMocks = vi.hoisted(() => ({
  loadRemoteAppDataSnapshot: vi.fn(),
  saveRemoteAppData: vi.fn(),
  subscribeToRemoteAppData: vi.fn()
}));

vi.mock("../backend", () => backendMocks);

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
        VITE_BACKEND_RPC_FINANCIAL_WRITES: "false"
      }
    );

    expect(flags.normalizedConfigReads).toBe(true);
    expect(flags.normalizedCatalogReads).toBe(false);
    expect(flags.rpcFinancialWrites).toBe(true);
  });
});

describe("app_state data gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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

  it("uses the guarded normalized skeleton when a future backend flag is enabled", async () => {
    const gateway = createRemoteDataGateway({
      ...DEFAULT_BACKEND_FEATURE_FLAGS,
      normalizedCatalogReads: true
    });

    await expect(gateway.loadAppDataSnapshot()).rejects.toThrow("Normalized data gateway is not implemented yet");
    await expect(gateway.saveAppData(createAppData(), "user-1", 1)).rejects.toThrow(
      "Normalized data gateway is not implemented yet"
    );
    expect(() => gateway.subscribeToAppData(vi.fn())).toThrow("Normalized data gateway is not implemented yet");
  });
});
