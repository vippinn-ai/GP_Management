import { describe, expect, it } from "vitest";
import {
  buildClientInventoryReportForActiveView,
  EMPTY_INVENTORY_REPORT_MODEL
} from "./inventoryReportActivation";
import type { InventoryItem } from "./types";

describe("client inventory report activation", () => {
  it("does not inspect report collections while the report view is inactive", () => {
    const inaccessible = new Proxy([], {
      get() {
        throw new Error("Inactive inventory report data was inspected.");
      }
    });

    expect(buildClientInventoryReportForActiveView({
      active: false,
      inventoryItems: inaccessible as InventoryItem[],
      stockMovements: inaccessible,
      sessions: inaccessible,
      customerTabs: inaccessible,
      bills: inaccessible,
      fromDate: "2026-09-14",
      toDate: "2026-09-14",
      search: ""
    })).toBe(EMPTY_INVENTORY_REPORT_MODEL);
  });

  it("preserves report construction and filtering when the report view is active", () => {
    const item: InventoryItem = {
      id: "item-cola",
      name: "Cola",
      category: "Beverages",
      price: 50,
      stockQty: 12,
      lowStockThreshold: 3,
      unit: "pcs",
      isReusable: false,
      active: true,
      saleVariants: []
    };
    const excludedItem: InventoryItem = {
      ...item,
      id: "item-tea",
      name: "Tea"
    };

    const result = buildClientInventoryReportForActiveView({
      active: true,
      inventoryItems: [item, excludedItem],
      stockMovements: [
        {
          id: "movement-cola",
          itemId: item.id,
          type: "restock",
          quantity: 4,
          reason: "Opening stock",
          createdAt: "2026-09-14T08:00:00.000Z",
          userId: "user-1"
        },
        {
          id: "movement-tea",
          itemId: excludedItem.id,
          type: "restock",
          quantity: 7,
          reason: "Opening stock",
          createdAt: "2026-09-14T08:01:00.000Z",
          userId: "user-1"
        }
      ],
      sessions: [],
      customerTabs: [],
      bills: [],
      fromDate: "2026-09-14",
      toDate: "2026-09-14",
      search: "cola"
    });

    expect(result.summary).toMatchObject({ added: 4, netChange: 4, touchedItems: 1 });
    expect(result.rows).toEqual([expect.objectContaining({ itemId: item.id, added: 4 })]);
    expect(result.details).toEqual([expect.objectContaining({ id: "movement-cola" })]);
    expect(result.rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ itemId: excludedItem.id })]));
    expect(result.details).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "movement-tea" })]));
  });
});
