import { describe, expect, it } from "vitest";
import { hydrateAppData } from "./storage";
import {
  getActiveInventoryItems,
  getArchivedInventoryItems,
  getInventoryItemOpenUsage,
  getSellableInventoryOptions
} from "./utils";
import type { Bill, CustomerTab, InventoryItem, Session } from "./types";

const NOW = new Date(2026, 5, 8, 12, 0, 0).toISOString();

function makeInventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "item-1",
    name: "Momo",
    category: "Food",
    price: 10,
    stockQty: 100,
    lowStockThreshold: 10,
    unit: "piece",
    isReusable: false,
    active: true,
    sellBaseItem: true,
    ...overrides
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    stationId: "station-1",
    stationNameSnapshot: "PS5",
    mode: "timed",
    startedAt: NOW,
    status: "active",
    playMode: "group",
    ltpEligible: false,
    pricingSnapshot: [],
    items: [],
    pauseLogIds: [],
    ...overrides
  };
}

function makeCustomerTab(overrides: Partial<CustomerTab> = {}): CustomerTab {
  return {
    id: "tab-1",
    customerName: "Walk-in",
    status: "open",
    createdAt: NOW,
    items: [],
    ...overrides
  };
}

describe("inventory archive behavior", () => {
  it("hydrates existing items as active by default", () => {
    const data = hydrateAppData({
      inventoryItems: [
        {
          id: "legacy-item",
          name: "Legacy Item",
          category: "Food",
          price: 10,
          stockQty: 1,
          lowStockThreshold: 1,
          unit: "piece",
          isReusable: false
        } as InventoryItem
      ]
    });

    expect(data.inventoryItems[0].active).toBe(true);
  });

  it("hydrates inactive items as archived and normalizes archive metadata", () => {
    const data = hydrateAppData({
      inventoryItems: [
        makeInventoryItem({
          active: false,
          archivedAt: NOW,
          archivedByUserId: "user-1",
          archiveReason: "  duplicate  "
        })
      ]
    });

    expect(data.inventoryItems[0]).toMatchObject({
      active: false,
      archivedAt: NOW,
      archivedByUserId: "user-1",
      archiveReason: "duplicate"
    });
  });

  it("splits active and archived inventory items", () => {
    const active = makeInventoryItem({ id: "active", active: true });
    const archived = makeInventoryItem({ id: "archived", active: false });

    expect(getActiveInventoryItems([active, archived]).map((item) => item.id)).toEqual(["active"]);
    expect(getArchivedInventoryItems([active, archived]).map((item) => item.id)).toEqual(["archived"]);
  });

  it("excludes archived items from sellable options", () => {
    const archived = makeInventoryItem({
      active: false,
      saleVariants: [{ id: "plate", name: "Momo Plate", price: 80, stockUnitsPerSale: 8, active: true }]
    });

    expect(getSellableInventoryOptions([archived])).toEqual([]);
  });

  it("counts open usage and ignores closed sessions or closed tabs", () => {
    const sessions: Session[] = [
      makeSession({
        id: "open-session",
        items: [{ id: "line-1", inventoryItemId: "item-1", name: "Momo Plate", quantity: 2, unitPrice: 80, stockUnitsPerSale: 8, addedAt: NOW }]
      }),
      makeSession({
        id: "closed-session",
        status: "closed",
        items: [{ id: "line-2", inventoryItemId: "item-1", name: "Momo Plate", quantity: 10, unitPrice: 80, stockUnitsPerSale: 8, addedAt: NOW }]
      })
    ];
    const tabs: CustomerTab[] = [
      makeCustomerTab({
        id: "open-tab",
        customerName: "Amit",
        items: [{ id: "tab-line-1", inventoryItemId: "item-1", name: "Momo", quantity: 3, unitPrice: 10, addedAt: NOW }]
      }),
      makeCustomerTab({
        id: "closed-tab",
        status: "closed",
        items: [{ id: "tab-line-2", inventoryItemId: "item-1", name: "Momo", quantity: 4, unitPrice: 10, addedAt: NOW }]
      })
    ];

    const usage = getInventoryItemOpenUsage("item-1", sessions, tabs);

    expect(usage.totalQuantity).toBe(19);
    expect(usage.sessionMatches).toEqual([{ label: "PS5", quantity: 16 }]);
    expect(usage.tabMatches).toEqual([{ label: "Amit", quantity: 3 }]);
  });

  it("keeps historical bill descriptions after the source item is archived", () => {
    const bill: Bill = {
      id: "bill-1",
      billNumber: "BILL-1",
      status: "issued",
      createdAt: NOW,
      issuedAt: NOW,
      issuedByUserId: "user-1",
      paymentMode: "cash",
      amountPaid: 80,
      amountDue: 0,
      subtotal: 80,
      totalDiscountAmount: 0,
      billDiscountAmount: 0,
      roundOffEnabled: false,
      roundOffAmount: 0,
      total: 80,
      lineDiscounts: [],
      lines: [{
        id: "line-1",
        type: "inventory_item",
        description: "Momo Plate",
        quantity: 1,
        unitPrice: 80,
        subtotal: 80,
        discountAmount: 0,
        total: 80,
        inventoryItemId: "item-1"
      }],
      receiptType: "digital"
    };

    const data = hydrateAppData({
      inventoryItems: [makeInventoryItem({ active: false })],
      bills: [bill]
    });

    expect(data.bills[0].lines[0].description).toBe("Momo Plate");
  });
});
