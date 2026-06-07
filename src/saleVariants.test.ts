import { describe, expect, it } from "vitest";
import {
  buildBillPreview,
  cloneBillLinesForReplacement,
  getCustomerTabCheckoutLines,
  getInventoryQuantityMap,
  getLineStockQuantity,
  getSellableInventoryOptions,
  getSessionCheckoutLines
} from "./utils";
import type { AppData, CustomerTabItem, DraftBillLine, InventoryItem, Session, SessionChargeSummary } from "./types";

const NOW = new Date(2026, 5, 7, 12, 0, 0).toISOString();

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

function makeSession(items: Session["items"]): Session {
  return {
    id: "session-1",
    stationId: "station-1",
    stationNameSnapshot: "PS5",
    mode: "unit_sale",
    startedAt: NOW,
    status: "active",
    playMode: "group",
    ltpEligible: false,
    pricingSnapshot: [],
    items,
    pauseLogIds: []
  };
}

const noCharge: SessionChargeSummary = {
  subtotal: 0,
  billedHours: 0,
  billedMinutes: 0,
  pauseMinutes: 0,
  segments: []
};

describe("sale variants", () => {
  it("builds base and variant sellable options from one source item", () => {
    const item = makeInventoryItem({
      name: "Maggi",
      saleVariants: [
        { id: "plain", name: "Plain Maggi", price: 50, stockUnitsPerSale: 1, active: true },
        { id: "masala", name: "Masala Maggi", price: 70, stockUnitsPerSale: 1, active: true }
      ]
    });

    const options = getSellableInventoryOptions([item]);

    expect(options.map((option) => option.name)).toEqual(["Maggi", "Plain Maggi", "Masala Maggi"]);
    expect(options[1]).toMatchObject({
      inventoryItemId: "item-1",
      saleVariantId: "plain",
      sourceName: "Maggi",
      stockUnitsPerSale: 1,
      price: 50
    });
  });

  it("honors stock-only source items when sellBaseItem is false", () => {
    const item = makeInventoryItem({
      sellBaseItem: false,
      saleVariants: [{ id: "plate", name: "Momo Plate", price: 80, stockUnitsPerSale: 8, active: true }]
    });

    expect(getSellableInventoryOptions([item]).map((option) => option.name)).toEqual(["Momo Plate"]);
  });

  it("computes Momo plate availability with leftovers", () => {
    const item = makeInventoryItem({
      saleVariants: [{ id: "plate", name: "Momo Plate", price: 80, stockUnitsPerSale: 8, active: true }]
    });
    const plate = getSellableInventoryOptions([item]).find((option) => option.saleVariantId === "plate");

    expect(plate).toBeDefined();
    expect(Math.floor(item.stockQty / plate!.stockUnitsPerSale)).toBe(12);
    expect(item.stockQty % plate!.stockUnitsPerSale).toBe(4);
  });

  it("uses quantity times stockUnitsPerSale for variant stock deduction", () => {
    expect(getLineStockQuantity({ quantity: 3, stockUnitsPerSale: 8 })).toBe(24);
  });

  it("aggregates multiple variants from one source item into source stock units", () => {
    const lines: DraftBillLine[] = [
      {
        id: "plain",
        type: "inventory_item",
        description: "Plain Maggi",
        quantity: 2,
        unitPrice: 50,
        inventoryItemId: "maggi",
        saleVariantId: "plain",
        stockUnitsPerSale: 1
      },
      {
        id: "masala",
        type: "inventory_item",
        description: "Masala Maggi",
        quantity: 3,
        unitPrice: 70,
        inventoryItemId: "maggi",
        saleVariantId: "masala",
        stockUnitsPerSale: 1
      }
    ];

    expect(getInventoryQuantityMap(lines)).toEqual({ maggi: 5 });
  });

  it("preserves variant fields through session checkout lines and bill preview", () => {
    const session = makeSession([
      {
        id: "line-1",
        inventoryItemId: "momo",
        saleVariantId: "plate",
        name: "Momo Plate",
        quantity: 2,
        unitPrice: 80,
        stockUnitsPerSale: 8,
        addedAt: NOW
      }
    ]);

    const draftLines = getSessionCheckoutLines(session, noCharge);
    const preview = buildBillPreview(draftLines, {});

    expect(draftLines[0]).toMatchObject({
      description: "Momo Plate",
      saleVariantId: "plate",
      stockUnitsPerSale: 8
    });
    expect(preview.processedLines[0]).toMatchObject({
      saleVariantId: "plate",
      stockUnitsPerSale: 8,
      subtotal: 160
    });
  });

  it("preserves variant fields through customer tab checkout lines", () => {
    const tabItem: CustomerTabItem = {
      id: "tab-line-1",
      inventoryItemId: "momo",
      saleVariantId: "plate",
      name: "Momo Plate",
      quantity: 1,
      unitPrice: 80,
      stockUnitsPerSale: 8,
      addedAt: NOW
    };

    expect(getCustomerTabCheckoutLines([tabItem])[0]).toMatchObject({
      description: "Momo Plate",
      saleVariantId: "plate",
      stockUnitsPerSale: 8
    });
  });

  it("preserves variant fields when cloning bill lines for replacement", () => {
    const bill: AppData["bills"][number] = {
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
      lines: [
        {
          id: "line-1",
          type: "inventory_item",
          description: "Momo Plate",
          quantity: 1,
          unitPrice: 80,
          subtotal: 80,
          discountAmount: 0,
          total: 80,
          inventoryItemId: "momo",
          saleVariantId: "plate",
          stockUnitsPerSale: 8
        }
      ],
      receiptType: "digital"
    };

    expect(cloneBillLinesForReplacement(bill)[0]).toMatchObject({
      saleVariantId: "plate",
      stockUnitsPerSale: 8
    });
  });
});
