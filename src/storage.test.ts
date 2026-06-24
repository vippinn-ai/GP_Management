import { afterEach, describe, expect, it, vi } from "vitest";
import { hasStoredAppData, loadAppData, saveAppData, setFullAppDataCacheEnabled } from "./storage";
import type { AppData } from "./types";

function createAppData(): AppData {
  return {
    users: [],
    businessProfile: { name: "", logoText: "", address: "", primaryPhone: "", receiptFooter: "" },
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

describe("storage", () => {
  afterEach(() => {
    setFullAppDataCacheEnabled(true);
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not throw when local app data cache exceeds browser quota", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded.", "QuotaExceededError");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => saveAppData(createAppData())).not.toThrow();
  });

  it("skips full app-data localStorage writes when the full cache is disabled", () => {
    const data = createAppData();
    data.businessProfile.name = "Remote only";

    setFullAppDataCacheEnabled(false);
    saveAppData(data);

    expect(hasStoredAppData()).toBe(false);
    expect(loadAppData().businessProfile.name).toBe("");
  });

  it("can ignore a legacy full cache while backend mode is loading", () => {
    const data = createAppData();
    data.businessProfile.name = "Legacy cache";
    saveAppData(data);

    expect(hasStoredAppData({ useStoredCache: false })).toBe(false);
    expect(loadAppData({ useStoredCache: false }).businessProfile.name).toBe("");
  });

  it("hydrates legacy combos as game combos", () => {
    const data = createAppData();
    data.combos.push({
      id: "combo-1",
      name: "Pool Combo",
      active: true,
      stationIds: ["station-1"],
      price: 799,
      includedMinutes: 60,
      fixedItems: [],
      choiceGroups: [],
      createdAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T10:00:00.000Z"
    });

    saveAppData(data);
    const loaded = loadAppData();

    expect(loaded.combos[0]).toMatchObject({
      type: "game",
      stationIds: ["station-1"],
      includedMinutes: 60
    });
  });

  it("hydrates consumables combos with no stations and zero game minutes", () => {
    const data = createAppData();
    data.combos.push({
      id: "combo-1",
      name: "Snack Combo",
      type: "consumables",
      active: true,
      stationIds: ["station-1"],
      price: 249,
      includedMinutes: 60,
      fixedItems: [{ id: "fixed-1", sellableOptionId: "maggi", quantity: 2 }],
      choiceGroups: [],
      createdAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T10:00:00.000Z"
    });

    saveAppData(data);
    const loaded = loadAppData();

    expect(loaded.combos[0]).toMatchObject({
      type: "consumables",
      stationIds: [],
      includedMinutes: 0
    });
  });
});
