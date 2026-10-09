import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DraftBillLine, Session } from "../types";
import { getSessionCheckoutLines } from "../utils";

interface PersistedInventoryBillLine {
  id: string;
  type: string;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  inventory_item_id: string | null;
  linked_session_id: string | null;
  sale_variant_id: string | null;
  sold_as_pack_of: number | string | null;
}

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function inventoryExpectation(lines: DraftBillLine[]) {
  return lines
    .filter((line) => line.type === "inventory_item")
    .map((line) => ({
      id: line.id,
      type: line.type,
      description: line.description,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      inventoryItemId: line.inventoryItemId,
      linkedSessionId: line.linkedSessionId ?? null,
      saleVariantId: line.saleVariantId ?? null,
      soldAsPackOf: line.soldAsPackOf ?? null
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function persistedInventory(lines: PersistedInventoryBillLine[]) {
  return lines
    .filter((line) => line.type === "inventory_item")
    .map((line) => ({
      id: line.id,
      type: line.type,
      description: line.description,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unit_price),
      inventoryItemId: line.inventory_item_id ?? undefined,
      linkedSessionId: line.linked_session_id,
      saleVariantId: line.sale_variant_id,
      soldAsPackOf: line.sold_as_pack_of === null ? null : Number(line.sold_as_pack_of)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function expectExactPersistedInventory(expected: DraftBillLine[], persisted: PersistedInventoryBillLine[]) {
  expect(persistedInventory(persisted)).toEqual(inventoryExpectation(expected));
}

const session: Session = {
  id: "session-unit-sale",
  stationId: "station-arcade-1",
  stationNameSnapshot: "Arcade 1",
  mode: "unit_sale",
  startedAt: "2026-10-09T16:23:45.000Z",
  endedAt: "2026-10-09T16:23:49.000Z",
  status: "closed",
  customerName: "QA Unit Sale",
  playMode: "group",
  ltpEligible: false,
  pricingSnapshot: [],
  items: [{
    id: "session-item-arcade-coin",
    inventoryItemId: "item-arcade-coins",
    name: "Arcade 1 Coin",
    quantity: 1,
    unitPrice: 5,
    addedAt: "2026-10-09T16:23:45.000Z"
  }],
  pauseLogIds: [],
  closeDisposition: "hopped"
};

const expectedLines = getSessionCheckoutLines(session, {
  subtotal: 0,
  billedHours: 0,
  billedMinutes: 0,
  pauseMinutes: 0,
  segments: []
});

const persistedLine: PersistedInventoryBillLine = {
  id: "line-item-session-item-arcade-coin",
  type: "inventory_item",
  description: "Arcade 1 Coin",
  quantity: 1,
  unit_price: 5,
  inventory_item_id: "item-arcade-coins",
  linked_session_id: null,
  sale_variant_id: null,
  sold_as_pack_of: null
};

describe("session inventory bill-line contract", () => {
  it("keeps a non-combo session inventory line unlinked while preserving its source item identity", () => {
    expect(expectedLines).toEqual([{
      id: "line-item-session-item-arcade-coin",
      type: "inventory_item",
      description: "Arcade 1 Coin",
      quantity: 1,
      unitPrice: 5,
      inventoryItemId: "item-arcade-coins",
      soldAsPackOf: undefined,
      saleVariantId: undefined,
      stockUnitsPerSale: undefined,
      comboApplicationId: undefined,
      comboId: undefined
    }]);
    expect(expectedLines[0]).not.toHaveProperty("linkedSessionId");
    expectExactPersistedInventory(expectedLines, [persistedLine]);
  });

  it.each([
    ["missing", []],
    ["extra", [persistedLine, { ...persistedLine, id: "line-extra" }]],
    ["duplicate exact ID", [persistedLine, { ...persistedLine }]],
    ["wrong inventory", [{ ...persistedLine, inventory_item_id: "item-other" }]],
    ["wrong description", [{ ...persistedLine, description: "Arcade Coin" }]],
    ["wrong quantity", [{ ...persistedLine, quantity: 2 }]],
    ["wrong price", [{ ...persistedLine, unit_price: 6 }]],
    ["wrong link", [{ ...persistedLine, linked_session_id: session.id }]],
    ["wrong variant", [{ ...persistedLine, sale_variant_id: "variant-pack" }]],
    ["wrong pack", [{ ...persistedLine, sold_as_pack_of: 10 }]]
  ] satisfies Array<[string, PersistedInventoryBillLine[]]>) (
    "rejects %s persisted inventory evidence",
    (_label, actual) => expect(() => expectExactPersistedInventory(expectedLines, actual)).toThrow()
  );

  it("preserves the formatted description and null link for a packed non-combo item", () => {
    const packed = getSessionCheckoutLines({
      ...session,
      items: [{
        ...session.items[0],
        id: "session-item-coin-pack",
        name: "Arcade Coin",
        quantity: 2,
        unitPrice: 40,
        soldAsPackOf: 10,
        stockUnitsPerSale: 10,
        saleVariantId: "variant-coin-pack"
      }]
    }, {
      subtotal: 0,
      billedHours: 0,
      billedMinutes: 0,
      pauseMinutes: 0,
      segments: []
    });

    expect(packed).toEqual([expect.objectContaining({
      id: "line-item-session-item-coin-pack",
      type: "inventory_item",
      description: "Arcade Coin (Pack of 10)",
      quantity: 2,
      unitPrice: 40,
      inventoryItemId: "item-arcade-coins",
      soldAsPackOf: 10,
      stockUnitsPerSale: 10,
      saleVariantId: "variant-coin-pack"
    })]);
    expect(packed[0]).not.toHaveProperty("linkedSessionId");
    expectExactPersistedInventory(packed, [{
      ...persistedLine,
      id: "line-item-session-item-coin-pack",
      description: "Arcade Coin (Pack of 10)",
      quantity: 2,
      unit_price: 40,
      sale_variant_id: "variant-coin-pack",
      sold_as_pack_of: 10
    }]);
  });

  it("pins both operational queries to bill scope instead of a linked-session filter", () => {
    for (const relativePath of [
      "tests/e2e/staging/operational-lifecycle-v2-continuations.e2e.ts",
      "tests/e2e/staging/operational-lifecycle-v2-hop-mutation-races.e2e.ts"
    ]) {
      const source = read(relativePath);
      const queryStart = source.indexOf('"bill_lines"');
      expect(queryStart, `${relativePath} must query bill_lines`).toBeGreaterThan(-1);
      const query = source.slice(queryStart, queryStart + 700);
      expect(query).toContain("bill_id: `eq.${billId}`");
      expect(query).not.toMatch(/linked_session_id\s*:\s*`eq\.\$\{sourceId\}`/);
      expect(query).toMatch(/select:\s*"[^"]*linked_session_id[^"]*"/);
    }
  });

  it("requires the unit-sale test to preserve pre-assert source and persisted line evidence", () => {
    const source = read("tests/e2e/staging/operational-lifecycle-v2-continuations.e2e.ts");
    const queryAt = source.indexOf('"bill_lines"');
    const assertionAt = source.indexOf("expect(billedItems).toEqual(itemsAfterStart.map(canonicalItem))");
    expect(queryAt).toBeGreaterThan(-1);
    expect(assertionAt).toBeGreaterThan(queryAt);
    const preAssertion = source.slice(queryAt, assertionAt);
    expect(preAssertion).toContain("attachJson(testInfo");
    expect(preAssertion).toContain("itemsAfterStart");
    expect(preAssertion).toContain("billLines");
  });

  it("pins the hop-race source to exact non-combo item parity and null links", () => {
    const source = read("tests/e2e/staging/operational-lifecycle-v2-hop-mutation-races.e2e.ts");
    expect(source).toContain("expect(billedInventory.every((line) => line.linked_session_id === null)).toBe(true)");
    expect(source).toContain("inventoryItemId: line.inventory_item_id, name: line.description");
    expect(source).toContain("saleVariantId: line.sale_variant_id, soldAsPackOf:");
    expect(source).toContain("quantity: Number(line.quantity), unitPrice: Number(line.unit_price)");
    expect(source).toContain("inventoryItemId: item.inventory_item_id, name: Number(item.sold_as_pack_of)");
    expect(source).toContain("saleVariantId: item.sale_variant_id, soldAsPackOf:");
    expect(source).toContain("itemsAfterBill.map((item)");
    expect(source).toContain("sale_variant_id,sold_as_pack_of");
  });
});
