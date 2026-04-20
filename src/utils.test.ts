import { describe, it, expect } from "vitest";
import {
  toLocalDateKey,
  getDiscountAmount,
  buildBillPreview,
  formatBillNumber,
  getReportRange,
  resolveEffectiveAmount
} from "./utils";
import type { AppData, DraftBillLine, ExpenseTemplate, ExpenseTemplateOverride } from "./types";

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
