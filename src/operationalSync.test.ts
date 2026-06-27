import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppData } from "./types";
import {
  applyOperationalMutation,
  loadPendingOperationalMutations,
  PENDING_OPERATION_STORAGE_KEY,
  rebasePendingMutations,
  savePendingOperationalMutations,
  validateOperationalMutation,
  type OperationalMutation,
  type OperationalMutationKind,
  type OperationalMutationPayload
} from "./operationalSync";

function createAppData(): AppData {
  return {
    users: [],
    businessProfile: { name: "", logoText: "", address: "", primaryPhone: "", receiptFooter: "" },
    inventoryCategories: [],
    stations: [{ id: "station-1", name: "Pool 1", mode: "timed", active: true, ltpEnabled: false }],
    pricingRules: [],
    sessions: [],
    sessionPauseLogs: [],
    customers: [],
    customerTabs: [],
    inventoryItems: [
      {
        id: "coke",
        name: "Coke",
        category: "Drinks",
        price: 40,
        stockQty: 5,
        lowStockThreshold: 2,
        unit: "piece",
        isReusable: false,
        active: true,
        sellBaseItem: true,
        saleVariants: []
      }
    ],
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

function mutation(
  kind: OperationalMutationKind,
  entityType: OperationalMutation["entityType"],
  entityId: string,
  payload: OperationalMutationPayload
): OperationalMutation {
  return {
    id: `op-${kind}`,
    kind,
    label: kind,
    userId: "user-1",
    createdAt: "2026-06-09T10:00:00.000Z",
    baseVersion: 1,
    status: "pending",
    entityType,
    entityId,
    payload
  };
}

describe("operational sync", () => {
  beforeEach(() => {
    window.localStorage.removeItem(PENDING_OPERATION_STORAGE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies a customer tab item operation immediately to local app data", () => {
    const appData = createAppData();
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: []
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("addCustomerTabItem", "customer_tab", "tab-1", {
        customerTabId: "tab-1",
        quantityDelta: 1,
        line: {
          id: "line-1",
          inventoryItemId: "coke",
          name: "Coke",
          quantity: 1,
          unitPrice: 40,
          addedAt: "2026-06-09T10:00:00.000Z"
        },
        auditLog: {
          id: "audit-1",
          action: "customer_tab_item_added",
          entityType: "customer_tab",
          entityId: "tab-1",
          message: "Added Coke.",
          createdAt: "2026-06-09T10:00:00.000Z",
          userId: "user-1"
        }
      })
    );

    expect(nextData.customerTabs[0].items).toHaveLength(1);
    expect(nextData.customerTabs[0].items[0].name).toBe("Coke");
    expect(nextData.auditLogs[0].id).toBe("audit-1");
  });

  it("links a hopped session to an open customer tab without duplicating session ids", () => {
    const appData = createAppData();
    appData.sessions.push({
      id: "session-hop-1",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-09T09:00:00.000Z",
      endedAt: "2026-06-09T10:00:00.000Z",
      status: "closed",
      customerName: "Vipin",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      pauseLogIds: [],
      closeDisposition: "hopped"
    });
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T10:05:00.000Z",
      items: [],
      continuedFromSessionIds: ["session-hop-1"]
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("linkCustomerTabContinuation", "customer_tab", "tab-1", {
        customerTabId: "tab-1",
        continuedFromSessionIds: ["session-hop-1"],
        auditLogs: [{
          id: "audit-link-1",
          action: "customer_tab_continuation_linked",
          entityType: "customer_tab",
          entityId: "tab-1",
          message: "Linked previous session.",
          createdAt: "2026-06-09T10:06:00.000Z",
          userId: "user-1"
        }]
      })
    );

    expect(nextData.customerTabs[0].continuedFromSessionIds).toEqual(["session-hop-1"]);
    expect(nextData.auditLogs[0].id).toBe("audit-link-1");
  });

  it("rejects customer tab continuation links for closed tabs or already billed sessions", () => {
    const appData = createAppData();
    appData.sessions.push({
      id: "session-hop-1",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-09T09:00:00.000Z",
      endedAt: "2026-06-09T10:00:00.000Z",
      status: "closed",
      customerName: "Vipin",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      pauseLogIds: [],
      closeDisposition: "hopped",
      closedBillId: "bill-1"
    });
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T10:05:00.000Z",
      items: []
    });

    const pending = mutation("linkCustomerTabContinuation", "customer_tab", "tab-1", {
      customerTabId: "tab-1",
      continuedFromSessionIds: ["session-hop-1"],
      auditLogs: []
    });

    expect(validateOperationalMutation(appData, pending)).toMatchObject({ ok: false });

    appData.customerTabs[0].status = "closed";
    appData.sessions[0].closedBillId = undefined;

    expect(validateOperationalMutation(appData, pending)).toMatchObject({ ok: false });
  });

  it("applies a rejected session operation and resumes any open pause log", () => {
    const appData = createAppData();
    appData.sessions.push({
      id: "session-1",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-09T09:00:00.000Z",
      status: "paused",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      comboApplications: [],
      pauseLogIds: ["pause-1"]
    });
    appData.sessionPauseLogs.push({
      id: "pause-1",
      sessionId: "session-1",
      pausedAt: "2026-06-09T09:30:00.000Z"
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("rejectSession", "session", "session-1", {
        session: {
          ...appData.sessions[0],
          status: "closed",
          endedAt: "2026-06-09T10:00:00.000Z",
          closeDisposition: "rejected",
          closeReason: "Wrong start"
        },
        pauseLog: {
          ...appData.sessionPauseLogs[0],
          resumedAt: "2026-06-09T10:00:00.000Z"
        },
        auditLog: {
          id: "audit-reject-session",
          action: "session_rejected",
          entityType: "session",
          entityId: "session-1",
          message: "Rejected Pool 1.",
          createdAt: "2026-06-09T10:00:00.000Z",
          userId: "user-1"
        }
      })
    );

    expect(nextData.sessions[0]).toMatchObject({
      status: "closed",
      closeDisposition: "rejected",
      closeReason: "Wrong start"
    });
    expect(nextData.sessionPauseLogs[0].resumedAt).toBe("2026-06-09T10:00:00.000Z");
    expect(nextData.auditLogs[0].id).toBe("audit-reject-session");
  });

  it("applies a hopped session operation and preserves the hopped close disposition", () => {
    const appData = createAppData();
    appData.sessions.push({
      id: "session-1",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-09T09:00:00.000Z",
      status: "paused",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      comboApplications: [],
      pauseLogIds: ["pause-1"]
    });
    appData.sessionPauseLogs.push({
      id: "pause-1",
      sessionId: "session-1",
      pausedAt: "2026-06-09T09:30:00.000Z"
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("hopSession", "session", "session-1", {
        session: {
          ...appData.sessions[0],
          status: "closed",
          endedAt: "2026-06-09T10:00:00.000Z",
          closeDisposition: "hopped"
        },
        pauseLog: {
          ...appData.sessionPauseLogs[0],
          resumedAt: "2026-06-09T10:00:00.000Z"
        },
        auditLog: {
          id: "audit-hop-session",
          action: "session_hopped",
          entityType: "session",
          entityId: "session-1",
          message: "Game hop: closed Pool 1 without billing.",
          createdAt: "2026-06-09T10:00:00.000Z",
          userId: "user-1"
        }
      })
    );

    expect(nextData.sessions[0]).toMatchObject({
      status: "closed",
      closeDisposition: "hopped",
      endedAt: "2026-06-09T10:00:00.000Z"
    });
    expect(nextData.sessionPauseLogs[0].resumedAt).toBe("2026-06-09T10:00:00.000Z");
    expect(nextData.auditLogs[0].id).toBe("audit-hop-session");
  });

  it("applies a rejected customer tab operation immediately to local app data", () => {
    const appData = createAppData();
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: []
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("rejectCustomerTab", "customer_tab", "tab-1", {
        tab: {
          ...appData.customerTabs[0],
          status: "closed",
          closedAt: "2026-06-09T10:00:00.000Z",
          closeDisposition: "rejected",
          closeReason: "Duplicate tab"
        },
        auditLog: {
          id: "audit-reject-tab",
          action: "customer_tab_rejected",
          entityType: "customer_tab",
          entityId: "tab-1",
          message: "Rejected tab.",
          createdAt: "2026-06-09T10:00:00.000Z",
          userId: "user-1"
        }
      })
    );

    expect(nextData.customerTabs[0]).toMatchObject({
      status: "closed",
      closeDisposition: "rejected",
      closeReason: "Duplicate tab"
    });
    expect(nextData.auditLogs[0].id).toBe("audit-reject-tab");
  });

  it("applies a consumables combo to a customer tab", () => {
    const appData = createAppData();
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: []
    });

    const nextData = applyOperationalMutation(
      appData,
      mutation("applyCustomerTabCombo", "customer_tab", "tab-1", {
        customerTabId: "tab-1",
        comboApplication: {
          id: "combo-app-1",
          comboId: "combo-1",
          comboName: "Snack Combo",
          price: 249,
          includedMinutes: 0,
          appliedAt: "2026-06-09T10:00:00.000Z",
          fixedItems: [{ inventoryItemId: "coke", name: "Coke", sourceName: "Coke", quantity: 2, unitPrice: 40, stockUnitsPerSale: 1 }],
          choices: []
        },
        items: [{
          id: "line-combo-1",
          inventoryItemId: "coke",
          name: "Coke",
          quantity: 2,
          unitPrice: 0,
          addedAt: "2026-06-09T10:00:00.000Z",
          comboApplicationId: "combo-app-1",
          comboId: "combo-1"
        }],
        auditLog: {
          id: "audit-combo",
          action: "customer_tab_combo_applied",
          entityType: "customer_tab",
          entityId: "tab-1",
          message: "Applied Snack Combo.",
          createdAt: "2026-06-09T10:00:00.000Z",
          userId: "user-1"
        }
      })
    );

    expect(nextData.customerTabs[0].comboApplications).toHaveLength(1);
    expect(nextData.customerTabs[0].items).toEqual([
      expect.objectContaining({ id: "line-combo-1", quantity: 2, unitPrice: 0, comboApplicationId: "combo-app-1" })
    ]);
    expect(nextData.auditLogs[0].id).toBe("audit-combo");
  });

  it("rebases a safe pending operation onto the latest remote state", () => {
    const remoteData = createAppData();
    remoteData.customerTabs.push({
      id: "tab-1",
      customerName: "Vipin",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: []
    });
    remoteData.auditLogs.unshift({
      id: "audit-remote",
      action: "remote_change",
      entityType: "session",
      entityId: "remote",
      message: "Remote change",
      createdAt: "2026-06-09T09:30:00.000Z",
      userId: "user-2"
    });

    const pending = mutation("addCustomerTabItem", "customer_tab", "tab-1", {
      customerTabId: "tab-1",
      quantityDelta: 1,
      line: {
        id: "line-1",
        inventoryItemId: "coke",
        name: "Coke",
        quantity: 1,
        unitPrice: 40,
        addedAt: "2026-06-09T10:00:00.000Z"
      },
      auditLog: {
        id: "audit-local",
        action: "customer_tab_item_added",
        entityType: "customer_tab",
        entityId: "tab-1",
        message: "Added Coke.",
        createdAt: "2026-06-09T10:00:00.000Z",
        userId: "user-1"
      }
    });

    const rebased = rebasePendingMutations(remoteData, [pending]);

    expect(rebased.conflicts).toHaveLength(0);
    expect(rebased.pendingMutations).toHaveLength(1);
    expect(rebased.appData.auditLogs.map((entry) => entry.id)).toContain("audit-remote");
    expect(rebased.appData.auditLogs.map((entry) => entry.id)).toContain("audit-local");
    expect(rebased.appData.customerTabs[0].items[0].id).toBe("line-1");
  });

  it("rejects a start-session operation when the station is already occupied remotely", () => {
    const remoteData = createAppData();
    remoteData.sessions.push({
      id: "remote-session",
      stationId: "station-1",
      stationNameSnapshot: "Pool 1",
      mode: "timed",
      startedAt: "2026-06-09T09:00:00.000Z",
      status: "active",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [],
      items: [],
      comboApplications: [],
      pauseLogIds: []
    });

    const pending = mutation("startSession", "session", "session-local", {
      session: {
        id: "session-local",
        stationId: "station-1",
        stationNameSnapshot: "Pool 1",
        mode: "timed",
        startedAt: "2026-06-09T10:00:00.000Z",
        status: "active",
        playMode: "group",
        ltpEligible: false,
        pricingSnapshot: [],
        items: [],
        comboApplications: [],
        pauseLogIds: []
      },
      stockMovements: [],
      auditLogs: []
    });

    expect(validateOperationalMutation(remoteData, pending)).toMatchObject({ ok: false });
    expect(rebasePendingMutations(remoteData, [pending]).conflicts[0].failureReason).toContain("already has an open session");
  });

  it("rejects stock conflicts against the latest remote reservations", () => {
    const remoteData = createAppData();
    remoteData.inventoryItems[0].stockQty = 1;
    remoteData.customerTabs.push({
      id: "tab-remote",
      customerName: "Remote",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: [{
        id: "remote-line",
        inventoryItemId: "coke",
        name: "Coke",
        quantity: 1,
        unitPrice: 40,
        addedAt: "2026-06-09T09:10:00.000Z"
      }]
    });
    remoteData.customerTabs.push({
      id: "tab-local",
      customerName: "Local",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: []
    });

    const pending = mutation("addCustomerTabItem", "customer_tab", "tab-local", {
      customerTabId: "tab-local",
      quantityDelta: 1,
      line: {
        id: "line-local",
        inventoryItemId: "coke",
        name: "Coke",
        quantity: 1,
        unitPrice: 40,
        addedAt: "2026-06-09T10:00:00.000Z"
      },
      auditLog: {
        id: "audit-local",
        action: "customer_tab_item_added",
        entityType: "customer_tab",
        entityId: "tab-local",
        message: "Added Coke.",
        createdAt: "2026-06-09T10:00:00.000Z",
        userId: "user-1"
      }
    });

    const rebased = rebasePendingMutations(remoteData, [pending]);

    expect(rebased.pendingMutations).toHaveLength(0);
    expect(rebased.conflicts).toHaveLength(1);
    expect(rebased.conflicts[0].failureReason).toContain("Coke");
  });

  it("persists queued operations for offline replay after refresh", () => {
    const pending = mutation("updateCustomerTabItemQuantity", "customer_tab", "tab-1", {
      customerTabId: "tab-1",
      lineId: "line-1",
      quantity: 2
    });

    savePendingOperationalMutations([pending]);

    expect(loadPendingOperationalMutations()).toEqual([pending]);
  });

  it("validates customer tab quantity updates against other same-source variant lines", () => {
    const appData = createAppData();
    appData.inventoryItems[0].name = "Momo";
    appData.inventoryItems[0].stockQty = 10;
    appData.inventoryItems[0].saleVariants = [
      { id: "fried", name: "Momo Fried", price: 80, stockUnitsPerSale: 4, active: true },
      { id: "steam", name: "Momo Steam", price: 70, stockUnitsPerSale: 4, active: true }
    ];
    appData.customerTabs.push({
      id: "tab-1",
      customerName: "Variant Customer",
      status: "open",
      createdAt: "2026-06-09T09:00:00.000Z",
      items: [
        {
          id: "fried-line",
          inventoryItemId: "coke",
          saleVariantId: "fried",
          stockUnitsPerSale: 4,
          name: "Momo Fried",
          quantity: 1,
          unitPrice: 80,
          addedAt: "2026-06-09T09:10:00.000Z"
        },
        {
          id: "steam-line",
          inventoryItemId: "coke",
          saleVariantId: "steam",
          stockUnitsPerSale: 4,
          name: "Momo Steam",
          quantity: 1,
          unitPrice: 70,
          addedAt: "2026-06-09T09:11:00.000Z"
        }
      ]
    });

    const pending = mutation("updateCustomerTabItemQuantity", "customer_tab", "tab-1", {
      customerTabId: "tab-1",
      lineId: "fried-line",
      quantity: 2
    });

    expect(validateOperationalMutation(appData, pending)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Momo")
    });
  });

  it("does not throw when pending operation cache exceeds browser quota", () => {
    const pending = mutation("updateCustomerTabItemQuantity", "customer_tab", "tab-1", {
      customerTabId: "tab-1",
      lineId: "line-1",
      quantity: 2
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded.", "QuotaExceededError");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => savePendingOperationalMutations([pending])).not.toThrow();
  });
});
