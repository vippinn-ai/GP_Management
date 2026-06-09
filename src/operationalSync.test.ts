import { beforeEach, describe, expect, it } from "vitest";
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
});
