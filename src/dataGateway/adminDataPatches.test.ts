import { describe, expect, it } from "vitest";
import type { AppData, ComboPackage, Expense, InventoryItem, User } from "../types";
import {
  adminDataChangePatchHasChanges,
  adminDataChangePatchHasUnsupportedChanges,
  buildAdminDataChangePatch
} from "./adminDataPatches";

function createAppData(overrides: Partial<AppData> = {}): AppData {
  return {
    users: [],
    businessProfile: {
      name: "BreakPerfect",
      logoText: "",
      address: "",
      primaryPhone: "",
      receiptFooter: ""
    },
    inventoryCategories: ["Snacks"],
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
    expenseTemplateOverrides: [],
    ...overrides
  };
}

describe("admin data change patches", () => {
  it("captures one-time expense additions and audit logs without unrelated collections", () => {
    const expense: Expense = {
      id: "expense-1",
      title: "Milk",
      category: "Kitchen",
      amount: 120,
      paymentMode: "cash",
      spentAt: "2026-06-25T09:00:00.000Z",
      createdByUserId: "user-1"
    };
    const nextAppData = createAppData({
      expenses: [expense],
      auditLogs: [
        {
          id: "audit-1",
          action: "expense_created",
          entityType: "expense",
          entityId: "expense-1",
          message: "Recorded one-time expense Milk.",
          createdAt: "2026-06-25T09:00:00.000Z",
          userId: "user-1"
        }
      ]
    });

    const patch = buildAdminDataChangePatch({
      baseAppData: createAppData(),
      nextAppData,
      baseVersion: 10,
      createdAt: "2026-06-25T09:00:01.000Z",
      userId: "user-1",
      mutationId: "admin-change-1",
      actionLabel: "Saving expense..."
    });

    expect(adminDataChangePatchHasChanges(patch)).toBe(true);
    expect(patch.expenses).toEqual([expense]);
    expect(patch.auditLogs).toHaveLength(1);
    expect(patch.inventoryItems).toEqual([]);
    expect(patch.combos).toEqual([]);
  });

  it("captures inventory updates, category changes, and sale variant snapshots", () => {
    const item: InventoryItem = {
      id: "item-1",
      name: "Momo",
      category: "Food",
      price: 80,
      stockQty: 10,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      active: true,
      sellBaseItem: false,
      saleVariants: [{ id: "fried", name: "Fried Momo", price: 100, stockUnitsPerSale: 8, active: true }]
    };

    const patch = buildAdminDataChangePatch({
      baseAppData: createAppData({ inventoryCategories: ["Snacks"] }),
      nextAppData: createAppData({ inventoryCategories: ["Snacks", "Food"], inventoryItems: [item] }),
      baseVersion: 11,
      createdAt: "2026-06-25T09:00:01.000Z",
      userId: "user-1",
      mutationId: "admin-change-2",
      actionLabel: "Saving inventory item..."
    });

    expect(patch.inventoryCategories).toEqual(["Snacks", "Food"]);
    expect(patch.inventoryItems).toEqual([item]);
    expect(patch.inventoryItemIdsToDelete).toEqual([]);
    expect(adminDataChangePatchHasUnsupportedChanges(createAppData(), createAppData({ inventoryItems: [item] }))).toBe(false);
  });

  it("captures inventory restocks with stock movements and audit logs", () => {
    const baseItem: InventoryItem = {
      id: "item-1",
      name: "Paneer Momo",
      category: "Food",
      price: 160,
      stockQty: 0,
      lowStockThreshold: 5,
      unit: "piece",
      isReusable: false,
      active: true,
      sellBaseItem: false,
      saleVariants: [{ id: "steam", name: "Steam Paneer Momo", price: 160, stockUnitsPerSale: 8, active: true }]
    };
    const nextItem: InventoryItem = { ...baseItem, stockQty: 100 };
    const nextAppData = createAppData({
      inventoryItems: [nextItem],
      stockMovements: [
        {
          id: "stock-1",
          itemId: "item-1",
          type: "restock",
          quantity: 100,
          reason: "Restock",
          createdAt: "2026-06-28T08:00:00.000Z",
          userId: "user-1"
        }
      ],
      auditLogs: [
        {
          id: "audit-1",
          action: "stock_movement",
          entityType: "inventory_item",
          entityId: "item-1",
          message: "restock for Paneer Momo.",
          createdAt: "2026-06-28T08:00:00.000Z",
          userId: "user-1"
        }
      ]
    });

    const patch = buildAdminDataChangePatch({
      baseAppData: createAppData({ inventoryItems: [baseItem] }),
      nextAppData,
      baseVersion: 13,
      createdAt: "2026-06-28T08:00:01.000Z",
      userId: "user-1",
      mutationId: "admin-change-restock",
      actionLabel: "Recording stock movement..."
    });

    expect(adminDataChangePatchHasChanges(patch)).toBe(true);
    expect(adminDataChangePatchHasUnsupportedChanges(createAppData({ inventoryItems: [baseItem] }), nextAppData)).toBe(false);
    expect(patch.inventoryItems).toEqual([{ ...nextItem, expectedStockQty: 0 }]);
    expect(patch.stockMovements).toEqual(nextAppData.stockMovements);
    expect(patch.auditLogs).toEqual(nextAppData.auditLogs);
  });

  it("carries the normalized stock precondition for existing item edits", () => {
    const baseItem: InventoryItem = {
      id: "item-1",
      name: "Cola",
      category: "Drinks",
      price: 40,
      stockQty: 12,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      active: true
    };
    const nextItem = { ...baseItem, price: 45 };

    const patch = buildAdminDataChangePatch({
      baseAppData: createAppData({ inventoryItems: [baseItem] }),
      nextAppData: createAppData({ inventoryItems: [nextItem] }),
      baseVersion: 14,
      createdAt: "2026-08-20T16:00:00.000Z",
      userId: "user-1",
      mutationId: "admin-change-stock-precondition",
      actionLabel: "Updating inventory item..."
    });

    expect(patch.inventoryItems).toEqual([{ ...nextItem, expectedStockQty: 12 }]);
  });

  it("flags unsupported user changes so they fall back to the full save path", () => {
    const user: User = {
      id: "user-1",
      name: "Admin",
      username: "admin",
      role: "admin",
      password: "hash",
      active: true
    };
    const baseAppData = createAppData();
    const nextAppData = createAppData({ users: [user] });
    const patch = buildAdminDataChangePatch({
      baseAppData,
      nextAppData,
      baseVersion: 14,
      createdAt: "2026-06-28T08:00:01.000Z",
      userId: "user-1",
      mutationId: "admin-change-user",
      actionLabel: "Creating user..."
    });

    expect(adminDataChangePatchHasChanges(patch)).toBe(false);
    expect(adminDataChangePatchHasUnsupportedChanges(baseAppData, nextAppData)).toBe(true);
  });

  it("captures combo changes and deleted combo ids", () => {
    const oldCombo: ComboPackage = {
      id: "combo-old",
      name: "Old Combo",
      type: "consumables",
      active: true,
      stationIds: [],
      price: 100,
      includedMinutes: 0,
      fixedItems: [],
      choiceGroups: [],
      createdAt: "2026-06-20T09:00:00.000Z",
      updatedAt: "2026-06-20T09:00:00.000Z"
    };
    const newCombo: ComboPackage = {
      ...oldCombo,
      id: "combo-new",
      name: "Snack Combo",
      fixedItems: [{ id: "fixed-1", sellableOptionId: "item-1", quantity: 2 }]
    };

    const patch = buildAdminDataChangePatch({
      baseAppData: createAppData({ combos: [oldCombo] }),
      nextAppData: createAppData({ combos: [newCombo] }),
      baseVersion: 12,
      createdAt: "2026-06-25T09:00:01.000Z",
      userId: "user-1",
      mutationId: "admin-change-3",
      actionLabel: "Creating combo..."
    });

    expect(patch.combos).toEqual([newCombo]);
    expect(patch.comboIdsToDelete).toEqual(["combo-old"]);
  });
});
