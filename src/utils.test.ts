import { describe, it, expect } from "vitest";
import {
  toLocalDateKey,
  getDiscountAmount,
  buildBillPreview,
  computePaymentModeTotals,
  allocatePaymentRevenueToBill,
  filterPaymentsByBusinessDate,
  getRevenueCountedPayments,
  getCustomerTabCheckoutLines,
  getDirectlyLinkedHoppedSessions,
  getMostRecentHoppedSession,
  getUnbilledHoppedSessionsForCustomer,
  formatBillNumber,
  getReportRange,
  resolveCustomerTabWorkspaceSelection,
  resolveEffectiveAmount,
  getPendingBillsForCustomer,
  getPendingReceivableGroups,
  getInventoryReportRange,
  buildInventoryReportModel,
  getCombosForStation,
  resolveComboFixedSelections,
  resolveComboChoiceSelections,
  getSessionCheckoutLines
} from "./utils";
import type { AppData, Bill, ComboPackage, CustomerTab, CustomerTabItem, DraftBillLine, ExpenseTemplate, ExpenseTemplateOverride, InventoryItem, Payment, PricingRule, SellableInventoryOption, Session, StockMovement } from "./types";

// ─── toLocalDateKey ─────────────────────────────────────────────────────────

describe("toLocalDateKey", () => {
  it("formats a Date object to YYYY-MM-DD", () => {
    expect(toLocalDateKey(new Date(2025, 0, 5))).toBe("2025-01-05");
  });

  it("formats a Date object in double-digit month and day", () => {
    expect(toLocalDateKey(new Date(2025, 11, 31))).toBe("2025-12-31");
  });

  it("accepts an ISO string produced from a local Date and round-trips correctly", () => {
    // Construct in local time so toLocalDateKey sees the same date regardless of timezone
    const localDate = new Date(2025, 5, 15); // June 15 2025, local midnight
    const key = toLocalDateKey(localDate.toISOString());
    expect(key).toBe("2025-06-15");
  });
});

describe("resolveCustomerTabWorkspaceSelection", () => {
  const tab = (id: string, customerName: string): CustomerTab => ({
    id,
    customerName,
    status: "open",
    createdAt: "2026-05-11T10:00:00.000Z",
    items: []
  });

  it("returns the explicitly selected tab when it exists", () => {
    const tabs = [tab("tab-a", "A"), tab("tab-b", "B")];
    expect(resolveCustomerTabWorkspaceSelection(tabs, "tab-a")?.id).toBe("tab-a");
  });

  it("does not fall back to another tab when the selected tab is missing", () => {
    const tabs = [tab("tab-b", "B"), tab("tab-c", "C")];
    expect(resolveCustomerTabWorkspaceSelection(tabs, "tab-a")).toBeNull();
  });

  it("auto-selects only when exactly one tab is open", () => {
    const tabs = [tab("tab-a", "A")];
    expect(resolveCustomerTabWorkspaceSelection(tabs, null)?.id).toBe("tab-a");
  });

  it("does not silently pick the first tab when multiple tabs are open", () => {
    const tabs = [tab("tab-a", "A"), tab("tab-b", "B")];
    expect(resolveCustomerTabWorkspaceSelection(tabs, null)).toBeNull();
  });
});

describe("buildBillPreview - customer tab with hopped session lines", () => {
  const tabItems: CustomerTabItem[] = [
    {
      id: "tab-line-coke",
      inventoryItemId: "coke",
      name: "Coke",
      quantity: 2,
      unitPrice: 40,
      addedAt: "2025-06-15T12:00:00Z"
    }
  ];

  const hoppedGameLine: DraftBillLine = {
    id: "line-session-hop-1",
    type: "session_charge",
    description: "PS5 session (60 min)",
    quantity: 1,
    unitPrice: 300,
    linkedSessionId: "hop-1"
  };

  it("includes selected previous game charges with customer tab consumables", () => {
    const result = buildBillPreview(
      [hoppedGameLine, ...getCustomerTabCheckoutLines(tabItems)],
      {}
    );

    expect(result.processedLines.map((line) => line.id)).toEqual([
      "line-session-hop-1",
      "tab-line-coke"
    ]);
    expect(result.subtotal).toBe(380);
  });

  it("excludes deselected previous game charges from customer tab preview", () => {
    const result = buildBillPreview(getCustomerTabCheckoutLines(tabItems), {});

    expect(result.processedLines.map((line) => line.id)).toEqual(["tab-line-coke"]);
    expect(result.subtotal).toBe(80);
  });
});

// ─── getDiscountAmount ───────────────────────────────────────────────────────

describe("getDiscountAmount", () => {
  const d = (type: "amount" | "percentage", value: number) => ({ type, value, reason: "" });

  it("returns 0 when no discount is provided", () => {
    expect(getDiscountAmount(1000)).toBe(0);
  });

  it("returns 0 when discount value is 0", () => {
    expect(getDiscountAmount(1000, d("amount", 0))).toBe(0);
  });

  it("returns 0 when discount value is negative", () => {
    expect(getDiscountAmount(1000, d("amount", -50))).toBe(0);
  });

  it("returns flat amount discount", () => {
    expect(getDiscountAmount(1000, d("amount", 200))).toBe(200);
  });

  it("clamps flat discount to subtotal", () => {
    expect(getDiscountAmount(100, d("amount", 300))).toBe(100);
  });

  it("returns percentage discount", () => {
    expect(getDiscountAmount(1000, d("percentage", 10))).toBe(100);
  });

  it("clamps percentage discount to subtotal (100%+)", () => {
    expect(getDiscountAmount(1000, d("percentage", 150))).toBe(1000);
  });

  it("handles partial percentages", () => {
    expect(getDiscountAmount(200, d("percentage", 25))).toBe(50);
  });
});

// ─── buildBillPreview ────────────────────────────────────────────────────────

const line = (id: string, unitPrice: number, quantity = 1): DraftBillLine => ({
  id,
  type: "inventory_item",
  description: `Item ${id}`,
  quantity,
  unitPrice
});

describe("buildBillPreview", () => {
  it("computes subtotal and total with no discounts", () => {
    const result = buildBillPreview([line("a", 100), line("b", 200)], {});
    expect(result.subtotal).toBe(300);
    expect(result.total).toBe(300);
    expect(result.lineDiscountAmount).toBe(0);
    expect(result.billDiscountAmount).toBe(0);
  });

  it("applies a line-level flat discount", () => {
    const result = buildBillPreview(
      [line("a", 500)],
      { a: { type: "amount", value: 100, reason: "" } }
    );
    expect(result.lineDiscountAmount).toBe(100);
    expect(result.total).toBe(400);
  });

  it("applies a bill-level percentage discount after line discounts", () => {
    const result = buildBillPreview(
      [line("a", 1000)],
      {},
      { type: "percentage", value: 10, reason: "" }
    );
    expect(result.billDiscountAmount).toBe(100);
    expect(result.total).toBe(900);
  });

  it("applies round-off when enabled", () => {
    const result = buildBillPreview(
      [line("a", 99), line("b", 1)],
      {},
      { type: "percentage", value: 10, reason: "" },
      true
    );
    expect(result.total).toBe(Math.round(result.total));
  });

  it("computes correct total with quantity > 1", () => {
    const result = buildBillPreview([line("a", 50, 4)], {});
    expect(result.subtotal).toBe(200);
    expect(result.total).toBe(200);
  });

  it("returns zero total for empty lines", () => {
    const result = buildBillPreview([], {});
    expect(result.subtotal).toBe(0);
    expect(result.total).toBe(0);
  });

  it("isZeroTotal is true for empty lines", () => {
    const result = buildBillPreview([], {});
    expect(result.isZeroTotal).toBe(true);
  });

  it("isZeroTotal is true for zero-price items (subtotal = 0)", () => {
    const result = buildBillPreview([line("a", 0), line("b", 0)], {});
    expect(result.subtotal).toBe(0);
    expect(result.isZeroTotal).toBe(true);
  });

  it("isZeroTotal is false when full line discount drives total to 0 (subtotal > 0)", () => {
    const result = buildBillPreview(
      [line("a", 500)],
      { a: { type: "amount", value: 500, reason: "full discount" } }
    );
    expect(result.subtotal).toBe(500);
    expect(result.total).toBe(0);
    expect(result.isZeroTotal).toBe(false);
  });

  it("isZeroTotal is false when full bill-level discount drives total to 0", () => {
    const result = buildBillPreview(
      [line("a", 300)],
      {},
      { type: "amount", value: 300, reason: "full bill discount" }
    );
    expect(result.subtotal).toBe(300);
    expect(result.total).toBe(0);
    expect(result.isZeroTotal).toBe(false);
  });

  it("isZeroTotal is false for LTP-win scenario — session charge line fully discounted", () => {
    const sessionLine: DraftBillLine = {
      id: "line-session-s1",
      type: "session_charge",
      description: "Arena session (60 min)",
      quantity: 1,
      unitPrice: 400,
      linkedSessionId: "s1"
    };
    const result = buildBillPreview(
      [sessionLine],
      { "line-session-s1": { type: "amount", value: 400, reason: "LTP win - game charge waived" } }
    );
    expect(result.subtotal).toBe(400);
    expect(result.total).toBe(0);
    expect(result.isZeroTotal).toBe(false);
  });
});

// ─── formatBillNumber ────────────────────────────────────────────────────────

const emptyAppData = { bills: [] } as unknown as AppData;

// Use local-time ISO strings so formatBillNumber's `new Date(issuedAt)` extracts
// the expected local date regardless of the runner's timezone.
const jun15 = new Date(2025, 5, 15, 10, 0, 0).toISOString();
const jun15b = new Date(2025, 5, 15, 11, 0, 0).toISOString();
const jun15noon = new Date(2025, 5, 15, 12, 0, 0).toISOString();
const jun16 = new Date(2025, 5, 16, 9, 0, 0).toISOString();

const jun15Key = `${new Date(2025, 5, 15).getFullYear()}${String(new Date(2025, 5, 15).getMonth() + 1).padStart(2, "0")}${String(new Date(2025, 5, 15).getDate()).padStart(2, "0")}`;
const jun16Key = `${new Date(2025, 5, 16).getFullYear()}${String(new Date(2025, 5, 16).getMonth() + 1).padStart(2, "0")}${String(new Date(2025, 5, 16).getDate()).padStart(2, "0")}`;

describe("formatBillNumber", () => {
  it("generates BILL-YYYYMMDD-001 for first bill of the day", () => {
    expect(formatBillNumber(emptyAppData, jun15)).toBe(`BILL-${jun15Key}-001`);
  });

  it("increments sequence for subsequent bills on same day", () => {
    const appDataWithOne = { bills: [{ billNumber: `BILL-${jun15Key}-001` }] } as unknown as AppData;
    expect(formatBillNumber(appDataWithOne, jun15b)).toBe(`BILL-${jun15Key}-002`);
  });

  it("resets sequence for a different day", () => {
    const appDataWithOne = { bills: [{ billNumber: `BILL-${jun15Key}-001` }] } as unknown as AppData;
    expect(formatBillNumber(appDataWithOne, jun16)).toBe(`BILL-${jun16Key}-001`);
  });

  it("pads sequence to 3 digits", () => {
    const bills = Array.from({ length: 9 }, (_, i) => ({
      billNumber: `BILL-${jun15Key}-00${i + 1}`
    }));
    expect(formatBillNumber({ bills } as unknown as AppData, jun15noon)).toBe(`BILL-${jun15Key}-010`);
  });
});

// ─── getReportRange ──────────────────────────────────────────────────────────

const now = "2025-06-15T12:00:00";

describe("getReportRange", () => {
  it("returns today range", () => {
    const range = getReportRange({ preset: "today" }, now);
    expect(range.from).toBe("2025-06-15");
    expect(range.to).toBe("2025-06-15");
    expect(range.label).toBe("Today");
  });

  it("returns yesterday range", () => {
    const range = getReportRange({ preset: "yesterday" }, now);
    expect(range.from).toBe("2025-06-14");
    expect(range.to).toBe("2025-06-14");
    expect(range.label).toBe("Yesterday");
  });

  it("returns last 7 days range", () => {
    const range = getReportRange({ preset: "last_7_days" }, now);
    expect(range.from).toBe("2025-06-09");
    expect(range.to).toBe("2025-06-15");
  });

  it("returns this month range", () => {
    const range = getReportRange({ preset: "this_month" }, now);
    expect(range.from).toBe("2025-06-01");
    expect(range.to).toBe("2025-06-30");
    expect(range.label).toBe("This Month");
  });

  it("returns last month range", () => {
    const range = getReportRange({ preset: "last_month" }, now);
    expect(range.from).toBe("2025-05-01");
    expect(range.to).toBe("2025-05-31");
    expect(range.label).toBe("Last Month");
  });

  it("returns this year range", () => {
    const range = getReportRange({ preset: "this_year" }, now);
    expect(range.from).toBe("2025-01-01");
    expect(range.to).toBe("2025-12-31");
  });

  it("returns custom range from filter dates", () => {
    const range = getReportRange({ preset: "custom", fromDate: "2025-04-01", toDate: "2025-04-30" }, now);
    expect(range.from).toBe("2025-04-01");
    expect(range.to).toBe("2025-04-30");
  });

  it("falls back to today when custom has no dates", () => {
    const range = getReportRange({ preset: "custom" }, now);
    expect(range.from).toBe("2025-06-15");
  });
});

// ─── resolveEffectiveAmount ──────────────────────────────────────────────────

const baseTemplate: ExpenseTemplate = {
  id: "tmpl-1",
  title: "Rent",
  category: "Rent",
  amount: 10000,
  frequency: "monthly",
  startMonth: "2026-01",
  active: true,
  createdByUserId: "user-1"
};

describe("resolveEffectiveAmount", () => {
  it("returns template base amount when no overrides exist", () => {
    expect(resolveEffectiveAmount(baseTemplate, "2026-04", [])).toBe(10000);
  });

  it("returns override amount when an amount override exists", () => {
    const overrides: ExpenseTemplateOverride[] = [{
      id: "ovr-1", templateId: "tmpl-1", monthKey: "2026-04",
      amount: 12000, createdByUserId: "user-1", updatedAt: ""
    }];
    expect(resolveEffectiveAmount(baseTemplate, "2026-04", overrides)).toBe(12000);
  });

  it("returns null for a skipped month (amount === null)", () => {
    const overrides: ExpenseTemplateOverride[] = [{
      id: "ovr-2", templateId: "tmpl-1", monthKey: "2026-06",
      amount: null, skipReason: "waived", createdByUserId: "user-1", updatedAt: ""
    }];
    expect(resolveEffectiveAmount(baseTemplate, "2026-06", overrides)).toBeNull();
  });

  it("returns null for a month before startMonth", () => {
    expect(resolveEffectiveAmount(baseTemplate, "2025-12", [])).toBeNull();
  });

  it("returns null when template is inactive", () => {
    const inactiveTemplate = { ...baseTemplate, active: false };
    expect(resolveEffectiveAmount(inactiveTemplate, "2026-04", [])).toBeNull();
  });

  it("ignores overrides for other templates", () => {
    const overrides: ExpenseTemplateOverride[] = [{
      id: "ovr-3", templateId: "tmpl-99", monthKey: "2026-04",
      amount: 99999, createdByUserId: "user-1", updatedAt: ""
    }];
    expect(resolveEffectiveAmount(baseTemplate, "2026-04", overrides)).toBe(10000);
  });
});

// ─── computePaymentModeTotals ────────────────────────────────────────────────

function makeBill(id: string, status: Bill["status"], amountPaid: number, overrides: Partial<Bill> = {}): Bill {
  return {
    id,
    billNumber: id,
    status,
    amountPaid,
    amountDue: 0,
    subtotal: amountPaid,
    total: amountPaid,
    totalDiscountAmount: 0,
    billDiscountAmount: 0,
    roundOffEnabled: false,
    roundOffAmount: 0,
    lineDiscounts: [],
    lines: [],
    paymentMode: "cash",
    createdAt: "2025-01-01T00:00:00Z",
    issuedAt: "2025-01-01T00:00:00Z",
    issuedByUserId: "u1",
    receiptType: "digital",
    ...overrides
  } as unknown as Bill;
}

function makePayment(billId: string, mode: Payment["mode"], amount: number, createdAt = "2025-01-01T00:00:00Z"): Payment {
  return { id: `pay-${billId}-${mode}-${createdAt}`, billId, mode, amount, createdAt, receivedByUserId: "u1" };
}

describe("pending receivable customer helpers", () => {
  it("finds pending bills by customer id, normalized phone, or normalized name", () => {
    const bills = [
      makeBill("by-id", "pending", 0, { customerId: "cust-1", amountDue: 100, total: 100 }),
      makeBill("by-phone", "pending", 0, { customerPhone: "+91 98765-43210", amountDue: 200, total: 200 }),
      makeBill("by-name", "pending", 0, { customerName: "Amit  Sharma", amountDue: 300, total: 300 }),
      makeBill("issued", "issued", 100, { customerId: "cust-1" })
    ];

    expect(getPendingBillsForCustomer(bills, "cust-1").map((bill) => bill.id)).toEqual(["by-id"]);
    expect(getPendingBillsForCustomer(bills, undefined, undefined, "+919876543210").map((bill) => bill.id)).toEqual(["by-phone"]);
    expect(getPendingBillsForCustomer(bills, undefined, "amit sharma").map((bill) => bill.id)).toEqual(["by-name"]);
  });

  it("groups pending bills and keeps unknown walk-ins separate", () => {
    const bills = [
      makeBill("b1", "pending", 0, { customerId: "cust-1", customerName: "Riya", amountDue: 100, total: 100, issuedAt: "2026-06-01T10:00:00.000Z" }),
      makeBill("b2", "pending", 0, { customerId: "cust-1", customerName: "Riya", amountDue: 150, total: 150, issuedAt: "2026-06-03T10:00:00.000Z" }),
      makeBill("b3", "pending", 0, { amountDue: 200, total: 200, issuedAt: "2026-06-02T10:00:00.000Z" }),
      makeBill("b4", "pending", 0, { amountDue: 250, total: 250, issuedAt: "2026-06-04T10:00:00.000Z" })
    ];

    const groups = getPendingReceivableGroups(
      bills,
      { b1: "2026-06-01", b2: "2026-06-03", b3: "2026-06-02", b4: "2026-06-04" },
      "2026-06-05"
    );

    const customerGroup = groups.find((group) => group.customerId === "cust-1");
    expect(customerGroup?.totalDue).toBe(250);
    expect(customerGroup?.bills.map((bill) => bill.id)).toEqual(["b1", "b2"]);
    expect(groups.filter((group) => group.isUngrouped).map((group) => group.bills[0].id).sort()).toEqual(["b3", "b4"]);
  });
});

describe("session combo helpers", () => {
  const combo: ComboPackage = {
    id: "combo-pool",
    name: "Pool Pot Combo",
    active: true,
    stationIds: ["pool-1"],
    price: 799,
    includedMinutes: 60,
    fixedItems: [{ id: "fixed-maggi", sellableOptionId: "maggi", quantity: 2 }],
    choiceGroups: [{ id: "fries-choice", label: "Fries", requiredQuantity: 1, optionIds: ["peri-fries", "salted-fries"] }],
    createdAt: "2026-06-08T10:00:00.000Z",
    updatedAt: "2026-06-08T10:00:00.000Z"
  };

  const option = (id: string, inventoryItemId: string, name: string, stockUnitsPerSale = 1): SellableInventoryOption => ({
    id,
    inventoryItemId,
    name,
    sourceName: name,
    category: "Food",
    price: 100,
    isBaseItem: !id.includes("variant"),
    stockUnitsPerSale,
    item: {
      id: inventoryItemId,
      name,
      category: "Food",
      price: 100,
      stockQty: 20,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      active: true
    }
  });

  it("filters active combos by station", () => {
    expect(getCombosForStation([combo], "pool-1").map((entry) => entry.id)).toEqual(["combo-pool"]);
    expect(getCombosForStation([combo], "s2")).toEqual([]);
    expect(getCombosForStation([{ ...combo, active: false }], "pool-1")).toEqual([]);
  });

  it("resolves fixed selections with stock units", () => {
    const options = [
      option("maggi", "maggi-item", "Maggi"),
      option("peri-fries", "fries-item", "Peri Fries", 2),
      option("salted-fries", "fries-item", "Salted Fries", 2)
    ];

    expect(resolveComboFixedSelections(combo, options)?.[0]).toMatchObject({
      inventoryItemId: "maggi-item",
      quantity: 2,
      stockUnitsPerSale: 1
    });
  });

  it("allows separate selections for each required choice quantity", () => {
    const drinkCombo = {
      ...combo,
      choiceGroups: [{ id: "drink-choice", label: "Drinks", requiredQuantity: 2, optionIds: ["coke", "shake"] }]
    };
    const options = [
      option("coke", "coke-item", "Coke"),
      option("shake", "shake-item", "Shake")
    ];

    const resolved = resolveComboChoiceSelections(drinkCombo, options, { "drink-choice": ["coke", "shake"] });

    expect(resolved?.[0].selections).toEqual([
      expect.objectContaining({ inventoryItemId: "coke-item", name: "Coke", quantity: 1 }),
      expect.objectContaining({ inventoryItemId: "shake-item", name: "Shake", quantity: 1 })
    ]);
  });

  it("aggregates repeated selections in the same choice group", () => {
    const drinkCombo = {
      ...combo,
      choiceGroups: [{ id: "drink-choice", label: "Drinks", requiredQuantity: 2, optionIds: ["coke", "shake"] }]
    };
    const options = [
      option("coke", "coke-item", "Coke"),
      option("shake", "shake-item", "Shake")
    ];

    const resolved = resolveComboChoiceSelections(drinkCombo, options, { "drink-choice": ["coke", "coke"] });

    expect(resolved?.[0].selections).toEqual([
      expect.objectContaining({ inventoryItemId: "coke-item", name: "Coke", quantity: 2 })
    ]);
  });

  it("keeps legacy single choice values supported", () => {
    const options = [
      option("maggi", "maggi-item", "Maggi"),
      option("peri-fries", "fries-item", "Peri Fries", 2)
    ];

    expect(resolveComboChoiceSelections(combo, options, { "fries-choice": "peri-fries" })?.[0].selections[0]).toMatchObject({
      inventoryItemId: "fries-item",
      quantity: 1,
      stockUnitsPerSale: 2
    });
  });

  it("creates combo package lines and only bills extra game time", () => {
    const pricingRule: PricingRule = {
      id: "rate-1",
      stationId: "pool-1",
      label: "Standard",
      startMinute: 0,
      endMinute: 0,
      hourlyRate: 300
    };
    const session: Session = {
      id: "session-1",
      stationId: "pool-1",
      stationNameSnapshot: "Pool",
      mode: "timed",
      startedAt: "2026-06-08T10:00:00.000Z",
      status: "active",
      playMode: "group",
      ltpEligible: false,
      pricingSnapshot: [pricingRule],
      items: [],
      comboApplications: [{
        id: "combo-app-1",
        comboId: combo.id,
        comboName: combo.name,
        price: 799,
        includedMinutes: 60,
        appliedAt: "2026-06-08T10:00:00.000Z",
        fixedItems: [{ inventoryItemId: "maggi-item", name: "Maggi", sourceName: "Maggi", quantity: 2, unitPrice: 100, stockUnitsPerSale: 1 }],
        choices: []
      }],
      pauseLogIds: []
    };

    const lines = getSessionCheckoutLines(session, {
      subtotal: 450,
      billedHours: 1.5,
      billedMinutes: 90,
      pauseMinutes: 0,
      segments: [{ label: "Standard", hourlyRate: 300, minutes: 90, subtotal: 450 }]
    });

    expect(lines.map((line) => [line.type, line.description, line.unitPrice])).toEqual([
      ["combo_package", "Pool Pot Combo", 799],
      ["combo_detail", "1 hr Pool play included", 0],
      ["inventory_item", "Maggi (included in Pool Pot Combo)", 0],
      ["session_charge", "Pool extra time (30 min)", 150]
    ]);
  });
});

describe("inventory report ranges", () => {
  it("anchors last 30 days on the current business day", () => {
    const now = new Date(2026, 5, 8, 3, 0, 0).toISOString();
    const range = getInventoryReportRange({ preset: "last_30_days" }, now);

    expect(range.from).toBe("2026-05-09");
    expect(range.to).toBe("2026-06-07");
    expect(range.label).toBe("Last 1 Month");
  });

  it("anchors yesterday relative to the 7 AM business day", () => {
    const now = new Date(2026, 5, 8, 3, 0, 0).toISOString();
    const range = getInventoryReportRange({ preset: "yesterday" }, now);

    expect(range.from).toBe("2026-06-06");
    expect(range.to).toBe("2026-06-06");
  });
});

describe("buildInventoryReportModel", () => {
  const inventoryItem = (patch: Partial<InventoryItem>): InventoryItem => ({
    id: "item-1",
    name: "Momo",
    category: "Food",
    price: 80,
    stockQty: 42,
    lowStockThreshold: 5,
    unit: "piece",
    isReusable: false,
    active: true,
    ...patch
  });

  const movement = (patch: Partial<StockMovement>): StockMovement => ({
    id: `movement-${patch.type ?? "stock"}`,
    itemId: "item-1",
    type: "restock",
    quantity: 0,
    reason: "test",
    createdAt: new Date(2026, 5, 8, 10, 0, 0).toISOString(),
    userId: "user-1",
    ...patch
  });

  const openSession = (itemId: string, quantity: number): Session => ({
    id: "session-1",
    stationId: "station-1",
    stationNameSnapshot: "PS5",
    mode: "timed",
    startedAt: new Date(2026, 5, 8, 10, 0, 0).toISOString(),
    status: "active",
    playMode: "group",
    ltpEligible: false,
    pricingSnapshot: [],
    items: [{
      id: "session-item-1",
      inventoryItemId: itemId,
      name: "Momo Plate",
      quantity,
      unitPrice: 80,
      addedAt: new Date(2026, 5, 8, 10, 5, 0).toISOString(),
      stockUnitsPerSale: 8
    }],
    pauseLogIds: []
  });

  const openTab = (itemId: string, quantity: number): CustomerTab => ({
    id: "tab-1",
    customerName: "Vipin",
    status: "open",
    createdAt: new Date(2026, 5, 8, 10, 0, 0).toISOString(),
    items: [{
      id: "tab-item-1",
      inventoryItemId: itemId,
      name: "Momo Plate",
      quantity,
      unitPrice: 80,
      addedAt: new Date(2026, 5, 8, 10, 10, 0).toISOString(),
      stockUnitsPerSale: 8
    }]
  });

  it("classifies finalized movements without double-counting reservations", () => {
    const item = inventoryItem({});
    const model = buildInventoryReportModel(
      [item],
      [
        movement({ id: "restock-1", type: "restock", quantity: 20 }),
        movement({ id: "sale-1", type: "sale", quantity: -8, relatedBillId: "bill-1" }),
        movement({ id: "adjustment-1", type: "adjustment", quantity: -2 }),
        movement({ id: "reversal-1", type: "void_refund_reversal", quantity: 3 }),
        movement({ id: "reservation-1", type: "session_reservation", quantity: -8 })
      ],
      [openSession(item.id, 1)],
      [openTab(item.id, 1)],
      [{ id: "bill-1", billNumber: "BILL-001" } as Bill],
      "2026-06-08",
      "2026-06-08"
    );

    expect(model.summary.added).toBe(20);
    expect(model.summary.deducted).toBe(8);
    expect(model.summary.manualAdjustments).toBe(-2);
    expect(model.summary.reversals).toBe(3);
    expect(model.summary.netChange).toBe(13);
    expect(model.summary.reserved).toBe(16);
    expect(model.rows[0]).toMatchObject({
      itemName: "Momo",
      added: 20,
      deducted: 8,
      manualAdjustments: -2,
      reversals: 3,
      netChange: 13,
      reserved: 16
    });
    expect(model.details.find((detail) => detail.id === "sale-1")?.relatedBillNumber).toBe("BILL-001");
  });

  it("includes archived items when they have movements in range", () => {
    const archived = inventoryItem({
      id: "item-archived",
      name: "Old Chips",
      active: false,
      archivedAt: new Date(2026, 5, 8, 12, 0, 0).toISOString()
    });
    const model = buildInventoryReportModel(
      [archived],
      [movement({ id: "archived-sale", itemId: archived.id, type: "sale", quantity: -5 })],
      [],
      [],
      [],
      "2026-06-08",
      "2026-06-08"
    );

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ itemName: "Old Chips", active: false, deducted: 5 });
  });
});

describe("computePaymentModeTotals", () => {
  it("all-cash issued bills — correct cash total, upi = 0", () => {
    const bills = [makeBill("b1", "issued", 500), makeBill("b2", "issued", 300)];
    const payments = [makePayment("b1", "cash", 500), makePayment("b2", "cash", 300)];
    const result = computePaymentModeTotals(bills, payments);
    expect(result.cash).toBe(800);
    expect(result.upi).toBe(0);
  });

  it("deferred bill with upfront cash payment — upfront included in cash total", () => {
    const issuedBill = makeBill("b1", "issued", 500);
    const pendingBill = makeBill("b2", "pending", 100); // ₹100 upfront collected
    const payments = [
      makePayment("b1", "cash", 500),
      makePayment("b2", "cash", 100)  // upfront payment on pending bill
    ];
    const result = computePaymentModeTotals([issuedBill, pendingBill], payments);
    expect(result.cash).toBe(600);
    expect(result.upi).toBe(0);
  });

  it("deferred bill with upfront UPI payment — upfront included in upi total", () => {
    const pendingBill = makeBill("b1", "pending", 150);
    const payments = [makePayment("b1", "upi", 150)];
    const result = computePaymentModeTotals([pendingBill], payments);
    expect(result.upi).toBe(150);
    expect(result.cash).toBe(0);
  });

  it("fully deferred bill (amountPaid = 0) — not included in payment mix", () => {
    const fullyDeferred = makeBill("b1", "pending", 0);
    const payments: Payment[] = [];
    const result = computePaymentModeTotals([fullyDeferred], payments);
    expect(result.cash).toBe(0);
    expect(result.upi).toBe(0);
  });

  it("settled deferred bill (status issued) — counted once via issued path, no double-count", () => {
    const settledBill = makeBill("b1", "issued", 400);
    // Two payment records: upfront ₹100 + settlement ₹300
    const payments = [makePayment("b1", "cash", 100), makePayment("b1", "cash", 300)];
    const result = computePaymentModeTotals([settledBill], payments);
    expect(result.cash).toBe(400);
  });

  it("payment mix cash + upi equals gross revenue when deferred bill has upfront", () => {
    const issuedBill = makeBill("b1", "issued", 7462);
    const pendingBill = makeBill("b2", "pending", 100);
    const payments = [
      makePayment("b1", "cash", 4185),
      makePayment("b1", "upi", 3277),
      makePayment("b2", "cash", 100)
    ];
    const result = computePaymentModeTotals([issuedBill, pendingBill], payments);
    const grossRevenue = 7462 + 100; // issuedRevenue + deferredCollected
    expect(result.cash + result.upi).toBe(grossRevenue);
  });

  // S2 — voided / replaced bills must not bleed into payment mix
  it("voided bill payments are excluded from payment mix", () => {
    const issuedBill = makeBill("b1", "issued", 300);
    const voidedBill = makeBill("b2", "voided", 0);
    const payments = [
      makePayment("b1", "cash", 300),
      makePayment("b2", "cash", 200)  // payment record still exists for voided bill
    ];
    const result = computePaymentModeTotals([issuedBill, voidedBill], payments);
    expect(result.cash).toBe(300);  // voided bill's ₹200 must not be counted
  });

  it("replaced bill payments are excluded from payment mix", () => {
    const replacementBill = makeBill("b1", "issued", 500);
    const replacedBill = makeBill("b2", "replaced", 0);
    const payments = [
      makePayment("b1", "cash", 500),
      makePayment("b2", "upi", 400)  // original payment record for now-replaced bill
    ];
    const result = computePaymentModeTotals([replacementBill, replacedBill], payments);
    expect(result.cash).toBe(500);
    expect(result.upi).toBe(0);  // replaced bill's ₹400 must not be counted
  });

  // S3 — split-payment bill: two payment records (cash + upi) both summed
  it("split-payment issued bill — both cash and upi records are summed correctly", () => {
    const splitBill = makeBill("b1", "issued", 700);
    const payments = [
      makePayment("b1", "cash", 400),
      makePayment("b1", "upi", 300)
    ];
    const result = computePaymentModeTotals([splitBill], payments);
    expect(result.cash).toBe(400);
    expect(result.upi).toBe(300);
  });

  it("multiple split bills — all cash and upi records totalled across bills", () => {
    const bill1 = makeBill("b1", "issued", 500);
    const bill2 = makeBill("b2", "issued", 600);
    const payments = [
      makePayment("b1", "cash", 200),
      makePayment("b1", "upi", 300),
      makePayment("b2", "cash", 100),
      makePayment("b2", "upi", 500)
    ];
    const result = computePaymentModeTotals([bill1, bill2], payments);
    expect(result.cash).toBe(300);
    expect(result.upi).toBe(800);
  });
});

describe("payment-date revenue helpers", () => {
  it("filters valid bill payments by payment business date, not bill issue date", () => {
    const bill = makeBill("b1", "issued", 500, { issuedAt: "2025-01-01T10:00:00Z" });
    const payments = [
      makePayment("b1", "cash", 200, "2025-01-01T10:00:00Z"),
      makePayment("b1", "upi", 300, "2025-01-02T10:00:00Z")
    ];
    const validPayments = getRevenueCountedPayments([bill], payments);
    const jan2Payments = filterPaymentsByBusinessDate(validPayments, "2025-01-02", "2025-01-02");
    expect(jan2Payments).toHaveLength(1);
    expect(jan2Payments[0].amount).toBe(300);
  });

  it("excludes payments for voided and replaced bills from revenue", () => {
    const issuedBill = makeBill("b1", "issued", 300);
    const voidedBill = makeBill("b2", "voided", 0);
    const replacedBill = makeBill("b3", "replaced", 0);
    const payments = [
      makePayment("b1", "cash", 300),
      makePayment("b2", "cash", 200),
      makePayment("b3", "upi", 100)
    ];
    const validPayments = getRevenueCountedPayments([issuedBill, voidedBill, replacedBill], payments);
    expect(validPayments.map((payment) => payment.billId)).toEqual(["b1"]);
  });

  it("allocates partial payment revenue proportionally across session and item lines", () => {
    const bill = makeBill("b1", "pending", 400, {
      total: 1000,
      totalDiscountAmount: 100,
      lines: [
        {
          id: "line-session",
          type: "session_charge",
          description: "Session",
          quantity: 1,
          unitPrice: 800,
          subtotal: 800,
          discountAmount: 0,
          total: 800
        },
        {
          id: "line-item",
          type: "inventory_item",
          description: "Red Bull",
          quantity: 2,
          unitPrice: 100,
          subtotal: 200,
          discountAmount: 0,
          total: 200
        }
      ]
    });
    const allocation = allocatePaymentRevenueToBill(bill, 400);
    expect(allocation.sessionRevenue).toBe(320);
    expect(allocation.itemRevenue).toBe(80);
    expect(allocation.totalDiscounts).toBe(40);
  });
});

// ─── getUnbilledHoppedSessionsForCustomer ────────────────────────────────────

function makeHoppedSession(id: string, customerName: string, customerPhone: string, closedBillId?: string): Session {
  return {
    id,
    stationId: "s1",
    stationNameSnapshot: "8 Ball Pool",
    mode: "timed",
    startedAt: "2025-06-15T10:00:00Z",
    endedAt: "2025-06-15T11:00:00Z",
    status: "closed",
    customerName,
    customerPhone,
    playMode: "group",
    ltpEligible: false,
    pricingSnapshot: [],
    items: [],
    pauseLogIds: [],
    closeDisposition: "hopped",
    closedBillId
  } as unknown as Session;
}

describe("getUnbilledHoppedSessionsForCustomer", () => {
  it("returns sessions matched by phone number", () => {
    const sessions = [
      makeHoppedSession("s1", "Alice", "9876543210"),
      makeHoppedSession("s2", "Bob", "1111111111")
    ];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "", "9876543210");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("returns sessions matched by name case-insensitively", () => {
    const sessions = [
      makeHoppedSession("s1", "Alice", ""),
      makeHoppedSession("s2", "Bob", "")
    ];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "ALICE", "");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("excludes sessions that are already billed (closedBillId set)", () => {
    const sessions = [
      makeHoppedSession("s1", "Alice", "9876543210", "bill-123"),
      makeHoppedSession("s2", "Alice", "9876543210")
    ];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "Alice", "9876543210");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s2");
  });

  it("excludes sessions with different closeDisposition", () => {
    const sessions: Session[] = [
      { ...makeHoppedSession("s1", "Alice", ""), closeDisposition: "rejected" } as unknown as Session
    ];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "Alice", "");
    expect(result).toHaveLength(0);
  });

  it("returns empty when name and phone are both blank", () => {
    const sessions = [makeHoppedSession("s1", "Alice", "9876543210")];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "", "");
    expect(result).toHaveLength(0);
  });

  it("phone takes priority — name match is ignored when phone is provided but does not match", () => {
    // Session belongs to "Alice" with phone 999. Caller provides Alice's name but a DIFFERENT phone.
    // Under the old (buggy) logic this would have matched by name. It must NOT match.
    const sessions = [makeHoppedSession("s1", "Alice", "9999999999")];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "Alice", "1111111111");
    expect(result).toHaveLength(0);
  });

  it("falls back to name match when no phone is provided", () => {
    const sessions = [makeHoppedSession("s1", "Alice", "9999999999")];
    const result = getUnbilledHoppedSessionsForCustomer(sessions, "Alice", "");
    expect(result).toHaveLength(1);
  });
});

// ─── getMostRecentHoppedSession ──────────────────────────────────────────────

describe("getDirectlyLinkedHoppedSessions", () => {
  it("returns only directly linked hopped sessions when duplicate names have no phone", () => {
    const sessions = [
      makeHoppedSession("hop-vansh-1", "VANSH", ""),
      makeHoppedSession("hop-vansh-2", "VANSH", "")
    ];

    const result = getDirectlyLinkedHoppedSessions(sessions, ["hop-vansh-2"]);

    expect(result.map((session) => session.id)).toEqual(["hop-vansh-2"]);
  });

  it("excludes already billed direct links", () => {
    const sessions = [
      makeHoppedSession("hop-vansh-1", "VANSH", "", "bill-1"),
      makeHoppedSession("hop-vansh-2", "VANSH", "")
    ];

    const result = getDirectlyLinkedHoppedSessions(sessions, ["hop-vansh-1", "hop-vansh-2"]);

    expect(result.map((session) => session.id)).toEqual(["hop-vansh-2"]);
  });

  it("excludes the current session from direct checkout candidates", () => {
    const sessions = [
      makeHoppedSession("hop-vansh-1", "VANSH", ""),
      makeHoppedSession("current", "VANSH", "")
    ];

    const result = getDirectlyLinkedHoppedSessions(sessions, ["hop-vansh-1", "current"], "current");

    expect(result.map((session) => session.id)).toEqual(["hop-vansh-1"]);
  });
});

describe("getMostRecentHoppedSession", () => {
  it("returns the session with the latest endedAt", () => {
    const sessions = [
      makeHoppedSession("s1", "Alice", ""),
      { ...makeHoppedSession("s2", "Alice", ""), endedAt: "2025-06-15T12:00:00Z" } as unknown as Session,
      makeHoppedSession("s3", "Alice", "")
    ];
    const result = getMostRecentHoppedSession(sessions);
    expect(result?.id).toBe("s2");
  });

  it("returns null when no hopped sessions exist", () => {
    expect(getMostRecentHoppedSession([])).toBeNull();
  });

  it("ignores sessions that are already billed", () => {
    const sessions = [makeHoppedSession("s1", "Alice", "", "bill-abc")];
    expect(getMostRecentHoppedSession(sessions)).toBeNull();
  });
});

// ─── Combined bill preview (getSessionCheckoutLines multi-session) ────────────

describe("buildBillPreview — combined multi-session lines", () => {
  it("combined lines from two sessions have correct total subtotal", () => {
    const sessionLine1: DraftBillLine = {
      id: "line-session-s1",
      type: "session_charge",
      description: "PS5 session (60 min)",
      quantity: 1,
      unitPrice: 300,
      linkedSessionId: "s1"
    };
    const sessionLine2: DraftBillLine = {
      id: "line-session-s2",
      type: "session_charge",
      description: "8 Ball Pool session (45 min)",
      quantity: 1,
      unitPrice: 200,
      linkedSessionId: "s2"
    };
    const result = buildBillPreview([sessionLine1, sessionLine2], {});
    expect(result.subtotal).toBe(500);
    expect(result.total).toBe(500);
    expect(result.isZeroTotal).toBe(false);
  });

  it("hopped session with items — item lines appear in combined bill", () => {
    const sessionCharge: DraftBillLine = {
      id: "line-session-s1",
      type: "session_charge",
      description: "PS5 session (30 min)",
      quantity: 1,
      unitPrice: 150,
      linkedSessionId: "s1"
    };
    const consumable: DraftBillLine = {
      id: "line-item-i1",
      type: "inventory_item",
      description: "Red Bull",
      quantity: 2,
      unitPrice: 60,
      inventoryItemId: "i1"
    };
    const result = buildBillPreview([sessionCharge, consumable], {});
    expect(result.processedLines).toHaveLength(2);
    expect(result.subtotal).toBe(270); // 150 + (2 × 60)
  });
});
