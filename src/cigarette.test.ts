import { describe, it, expect } from "vitest";
import { getSessionCheckoutLines, getCustomerTabCheckoutLines, buildBillPreview } from "./utils";
import type { Session, CustomerTabItem, SessionChargeSummary, PricingRule, DraftBillLine } from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOW = new Date(2025, 5, 15, 10, 0, 0).toISOString();

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    stationId: "st1",
    stationNameSnapshot: "PC-1",
    mode: "unit_sale",
    startedAt: NOW,
    status: "active",
    playMode: "solo",
    ltpEligible: false,
    pricingSnapshot: [] as PricingRule[],
    items: [],
    pauseLogIds: [],
    ...overrides
  };
}

const noCharge: SessionChargeSummary = {
  subtotal: 0,
  billedHours: 0,
  billedMinutes: 0,
  pauseMinutes: 0,
  segments: []
};

// ─── getSessionCheckoutLines — cigarette pack description ─────────────────────

describe("getSessionCheckoutLines — cigarette soldAsPackOf", () => {
  it("gives plain name for regular (non-pack) inventory items", () => {
    const session = makeSession({
      items: [
        {
          id: "i1",
          inventoryItemId: "inv1",
          name: "Pepsi",
          quantity: 2,
          unitPrice: 60,
          addedAt: NOW
        }
      ]
    });
    const lines = getSessionCheckoutLines(session, noCharge);
    const pepsiLine = lines.find((l) => l.inventoryItemId === "inv1");
    expect(pepsiLine?.description).toBe("Pepsi");
    expect(pepsiLine?.soldAsPackOf).toBeUndefined();
  });

  it("appends '(Pack of N)' to description when soldAsPackOf is set", () => {
    const session = makeSession({
      items: [
        {
          id: "i2",
          inventoryItemId: "cig1",
          name: "Marlboro",
          quantity: 1,
          unitPrice: 300,
          soldAsPackOf: 20,
          addedAt: NOW
        }
      ]
    });
    const lines = getSessionCheckoutLines(session, noCharge);
    const cigLine = lines.find((l) => l.inventoryItemId === "cig1");
    expect(cigLine?.description).toBe("Marlboro (Pack of 20)");
    expect(cigLine?.soldAsPackOf).toBe(20);
  });

  it("propagates soldAsPackOf to the draft line", () => {
    const session = makeSession({
      items: [
        {
          id: "i3",
          inventoryItemId: "cig2",
          name: "Gold Flake",
          quantity: 2,
          unitPrice: 150,
          soldAsPackOf: 10,
          addedAt: NOW
        }
      ]
    });
    const lines = getSessionCheckoutLines(session, noCharge);
    const line = lines.find((l) => l.inventoryItemId === "cig2");
    expect(line?.soldAsPackOf).toBe(10);
    expect(line?.quantity).toBe(2);
    expect(line?.unitPrice).toBe(150);
  });

  it("handles mixed single and pack items in the same session", () => {
    const session = makeSession({
      items: [
        {
          id: "i4",
          inventoryItemId: "cig1",
          name: "Marlboro",
          quantity: 1,
          unitPrice: 300,
          soldAsPackOf: 20,
          addedAt: NOW
        },
        {
          id: "i5",
          inventoryItemId: "cig1",
          name: "Marlboro",
          quantity: 3,
          unitPrice: 18,
          addedAt: NOW
        }
      ]
    });
    const lines = getSessionCheckoutLines(session, noCharge);
    const packLine = lines.find((l) => l.soldAsPackOf === 20);
    const singleLine = lines.find((l) => !l.soldAsPackOf && l.inventoryItemId === "cig1");
    expect(packLine?.description).toBe("Marlboro (Pack of 20)");
    expect(singleLine?.description).toBe("Marlboro");
  });
});

// ─── getCustomerTabCheckoutLines — cigarette pack description ─────────────────

function makeTabItem(overrides: Partial<CustomerTabItem> = {}): CustomerTabItem {
  return {
    id: "ti1",
    inventoryItemId: "cig1",
    name: "Marlboro",
    quantity: 1,
    unitPrice: 18,
    addedAt: NOW,
    ...overrides
  };
}

describe("getCustomerTabCheckoutLines — cigarette soldAsPackOf", () => {
  it("gives plain name for single-sold items", () => {
    const lines = getCustomerTabCheckoutLines([makeTabItem({ name: "Pepsi", inventoryItemId: "bev1" })]);
    expect(lines[0].description).toBe("Pepsi");
    expect(lines[0].soldAsPackOf).toBeUndefined();
  });

  it("appends '(Pack of N)' when soldAsPackOf is set", () => {
    const lines = getCustomerTabCheckoutLines([makeTabItem({ soldAsPackOf: 20, unitPrice: 300 })]);
    expect(lines[0].description).toBe("Marlboro (Pack of 20)");
  });

  it("propagates soldAsPackOf, quantity, and unitPrice unchanged", () => {
    const lines = getCustomerTabCheckoutLines([
      makeTabItem({ soldAsPackOf: 10, quantity: 3, unitPrice: 150 })
    ]);
    expect(lines[0].soldAsPackOf).toBe(10);
    expect(lines[0].quantity).toBe(3);
    expect(lines[0].unitPrice).toBe(150);
  });

  it("handles a tab with both pack and single lines for same item", () => {
    const items: CustomerTabItem[] = [
      makeTabItem({ id: "ti1", soldAsPackOf: 20, unitPrice: 300, quantity: 1 }),
      makeTabItem({ id: "ti2", soldAsPackOf: undefined, unitPrice: 18, quantity: 5 })
    ];
    const lines = getCustomerTabCheckoutLines(items);
    expect(lines[0].description).toBe("Marlboro (Pack of 20)");
    expect(lines[1].description).toBe("Marlboro");
  });
});

// ─── buildBillPreview — soldAsPackOf propagation ──────────────────────────────

const packLine = (id: string, quantity: number, unitPrice: number, soldAsPackOf: number): DraftBillLine => ({
  id,
  type: "inventory_item",
  description: `Marlboro (Pack of ${soldAsPackOf})`,
  quantity,
  unitPrice,
  soldAsPackOf
});

const singleLine = (id: string, quantity: number, unitPrice: number): DraftBillLine => ({
  id,
  type: "inventory_item",
  description: "Marlboro",
  quantity,
  unitPrice
});

describe("buildBillPreview — cigarette pack lines", () => {
  it("computes correct subtotal for a pack line (pack price × qty)", () => {
    const result = buildBillPreview([packLine("p1", 2, 300, 20)], {});
    expect(result.subtotal).toBe(600);
    expect(result.total).toBe(600);
  });

  it("propagates soldAsPackOf to the output BillLine", () => {
    const result = buildBillPreview([packLine("p1", 1, 300, 20)], {});
    const line = result.processedLines.find((l) => l.id === "p1");
    expect(line?.soldAsPackOf).toBe(20);
  });

  it("correctly totals mixed pack and single lines", () => {
    // 1 pack of 20 at ₹300 + 3 singles at ₹18 = ₹354
    const result = buildBillPreview(
      [packLine("p1", 1, 300, 20), singleLine("s1", 3, 18)],
      {}
    );
    expect(result.subtotal).toBe(354);
  });

  it("applies line discount to a pack line correctly", () => {
    // Pack line subtotal = 2 × 300 = 600; discount = 50 flat
    const result = buildBillPreview(
      [packLine("p1", 2, 300, 20)],
      { p1: { type: "amount", value: 50, reason: "promo" } }
    );
    expect(result.lineDiscountAmount).toBe(50);
    expect(result.total).toBe(550);
  });

  it("pack line without soldAsPackOf does not get the field set", () => {
    const result = buildBillPreview([singleLine("s1", 1, 18)], {});
    const line = result.processedLines.find((l) => l.id === "s1");
    expect(line?.soldAsPackOf).toBeUndefined();
  });
});

// ─── Stock math: soldAsPackOf multiplier logic ────────────────────────────────

describe("cigarette stock delta math", () => {
  it("stock deduction = quantity * soldAsPackOf for pack sales", () => {
    const quantity = 3;
    const soldAsPackOf = 20;
    const delta = soldAsPackOf ? quantity * soldAsPackOf : quantity;
    expect(delta).toBe(60);
  });

  it("stock deduction = quantity for single sales (no soldAsPackOf)", () => {
    const quantity = 5;
    const soldAsPackOf = undefined;
    const delta = soldAsPackOf ? quantity * soldAsPackOf : quantity;
    expect(delta).toBe(5);
  });

  it("void reversal restores the same quantity as was deducted", () => {
    const quantity = 2;
    const soldAsPackOf = 10;
    const deducted = soldAsPackOf ? quantity * soldAsPackOf : quantity;
    const restored = soldAsPackOf ? quantity * soldAsPackOf : quantity;
    expect(deducted).toBe(restored);
    expect(restored).toBe(20);
  });

  it("restock pack count converts to individual cigarettes correctly", () => {
    const packsRestocked = 5;
    const packSize = 20;
    const individualAdded = packsRestocked * packSize;
    expect(individualAdded).toBe(100);
  });

  it("pack display breakdown: ~X packs + Y loose", () => {
    const stockQty = 47;
    const packSize = 20;
    const packs = Math.floor(stockQty / packSize);
    const loose = stockQty % packSize;
    expect(packs).toBe(2);
    expect(loose).toBe(7);
  });

  it("stock reservation for a pack item = quantity * soldAsPackOf", () => {
    const items = [
      { inventoryItemId: "cig1", quantity: 2, soldAsPackOf: 20 },
      { inventoryItemId: "cig1", quantity: 3, soldAsPackOf: undefined as number | undefined }
    ];
    const reserved = items
      .filter((i) => i.inventoryItemId === "cig1")
      .reduce((sum, i) => sum + (i.soldAsPackOf ? i.quantity * i.soldAsPackOf : i.quantity), 0);
    // 2 packs × 20 + 3 singles = 43
    expect(reserved).toBe(43);
  });
});
