import { describe, it, expect } from "vitest";
import {
  validateCheckoutPayment,
  buildCheckoutPaymentResult,
  getSettlementAmount,
  computeSettlement,
  PAYMENT_TOLERANCE
} from "./billing";
import type { SettlementDraft } from "./types";

// ─── validateCheckoutPayment ─────────────────────────────────────────────────

describe("validateCheckoutPayment — cash / upi", () => {
  it("accepts cash payment", () => {
    expect(validateCheckoutPayment("cash", 0, 0, 0, 500)).toBeNull();
  });

  it("accepts upi payment", () => {
    expect(validateCheckoutPayment("upi", 0, 0, 0, 500)).toBeNull();
  });
});

describe("validateCheckoutPayment — split", () => {
  it("accepts split where cash + upi equals total exactly", () => {
    expect(validateCheckoutPayment("split", 300, 200, 0, 500)).toBeNull();
  });

  it("accepts split within floating-point tolerance", () => {
    expect(validateCheckoutPayment("split", 333.33, 166.67, 0, 500)).toBeNull();
  });

  it("rejects split where amounts are less than total", () => {
    const error = validateCheckoutPayment("split", 200, 200, 0, 500);
    expect(error).not.toBeNull();
    expect(error).toMatch(/400\.00.*500\.00/);
  });

  it("rejects split where amounts exceed total", () => {
    const error = validateCheckoutPayment("split", 300, 300, 0, 500);
    expect(error).not.toBeNull();
  });

  it("accepts split when cash is 0 (full UPI)", () => {
    expect(validateCheckoutPayment("split", 0, 500, 0, 500)).toBeNull();
  });

  it("accepts split when upi is 0 (full cash)", () => {
    expect(validateCheckoutPayment("split", 500, 0, 0, 500)).toBeNull();
  });
});

describe("validateCheckoutPayment — deferred", () => {
  it("accepts fully deferred (collectAmount = 0)", () => {
    expect(validateCheckoutPayment("deferred", 0, 0, 0, 500)).toBeNull();
  });

  it("accepts partial upfront collection", () => {
    expect(validateCheckoutPayment("deferred", 0, 0, 200, 500)).toBeNull();
  });

  it("accepts upfront equal to total (fully collected at checkout)", () => {
    expect(validateCheckoutPayment("deferred", 0, 0, 500, 500)).toBeNull();
  });

  it("rejects negative collectAmount", () => {
    const error = validateCheckoutPayment("deferred", 0, 0, -50, 500);
    expect(error).not.toBeNull();
    expect(error).toMatch(/negative/i);
  });

  it("rejects collectAmount exceeding total", () => {
    const error = validateCheckoutPayment("deferred", 0, 0, 600, 500);
    expect(error).not.toBeNull();
    expect(error).toMatch(/exceed/i);
  });

  it("accepts collectAmount within tolerance of total", () => {
    expect(validateCheckoutPayment("deferred", 0, 0, 500.005, 500)).toBeNull();
  });
});

// ─── buildCheckoutPaymentResult ──────────────────────────────────────────────

describe("buildCheckoutPaymentResult — cash", () => {
  it("produces one cash payment record for full amount", () => {
    const result = buildCheckoutPaymentResult("cash", 0, 0, 0, "cash", 500);
    expect(result.paymentRecords).toEqual([{ mode: "cash", amount: 500 }]);
  });

  it("sets status to issued and amountDue to 0", () => {
    const result = buildCheckoutPaymentResult("cash", 0, 0, 0, "cash", 500);
    expect(result.status).toBe("issued");
    expect(result.amountPaid).toBe(500);
    expect(result.amountDue).toBe(0);
  });
});

describe("buildCheckoutPaymentResult — upi", () => {
  it("produces one upi payment record for full amount", () => {
    const result = buildCheckoutPaymentResult("upi", 0, 0, 0, "cash", 300);
    expect(result.paymentRecords).toEqual([{ mode: "upi", amount: 300 }]);
    expect(result.status).toBe("issued");
  });
});

describe("buildCheckoutPaymentResult — split", () => {
  it("produces two payment records for a standard split", () => {
    const result = buildCheckoutPaymentResult("split", 300, 200, 0, "cash", 500);
    expect(result.paymentRecords).toHaveLength(2);
    expect(result.paymentRecords).toContainEqual({ mode: "cash", amount: 300 });
    expect(result.paymentRecords).toContainEqual({ mode: "upi", amount: 200 });
    expect(result.status).toBe("issued");
    expect(result.amountDue).toBe(0);
  });

  it("omits cash record when splitCashAmount is 0", () => {
    const result = buildCheckoutPaymentResult("split", 0, 500, 0, "cash", 500);
    expect(result.paymentRecords).toHaveLength(1);
    expect(result.paymentRecords[0].mode).toBe("upi");
  });

  it("omits upi record when splitUpiAmount is 0", () => {
    const result = buildCheckoutPaymentResult("split", 500, 0, 0, "cash", 500);
    expect(result.paymentRecords).toHaveLength(1);
    expect(result.paymentRecords[0].mode).toBe("cash");
  });
});

describe("buildCheckoutPaymentResult — deferred", () => {
  it("produces no payment records when fully deferred (collectAmount = 0)", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 0, "cash", 500);
    expect(result.paymentRecords).toHaveLength(0);
    expect(result.status).toBe("pending");
    expect(result.amountPaid).toBe(0);
    expect(result.amountDue).toBe(500);
  });

  it("produces one payment record for partial upfront collection", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 200, "cash", 500);
    expect(result.paymentRecords).toEqual([{ mode: "cash", amount: 200 }]);
    expect(result.status).toBe("pending");
    expect(result.amountPaid).toBe(200);
    expect(result.amountDue).toBe(300);
  });

  it("uses collectMode for the upfront payment record", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 150, "upi", 500);
    expect(result.paymentRecords).toEqual([{ mode: "upi", amount: 150 }]);
  });

  it("produces issued status when collectAmount equals total", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 500, "cash", 500);
    expect(result.status).toBe("issued");
    expect(result.amountDue).toBe(0);
    expect(result.paymentRecords).toHaveLength(1);
  });

  it("produces pending status when amountDue exceeds tolerance", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 499, "cash", 500);
    expect(result.status).toBe("pending");
    expect(result.amountDue).toBeCloseTo(1);
  });

  it("produces issued status when amountDue is within tolerance", () => {
    const result = buildCheckoutPaymentResult("deferred", 0, 0, 500 - PAYMENT_TOLERANCE / 2, "cash", 500);
    expect(result.status).toBe("issued");
  });
});

// ─── getSettlementAmount ─────────────────────────────────────────────────────

function makeDraft(overrides: Partial<SettlementDraft> = {}): SettlementDraft {
  return { billId: "b1", paymentMode: "cash", cashAmount: 0, upiAmount: 0, ...overrides };
}

describe("getSettlementAmount", () => {
  it("returns cashAmount for cash mode", () => {
    expect(getSettlementAmount(makeDraft({ paymentMode: "cash", cashAmount: 250 }))).toBe(250);
  });

  it("returns upiAmount for upi mode", () => {
    expect(getSettlementAmount(makeDraft({ paymentMode: "upi", upiAmount: 180 }))).toBe(180);
  });

  it("returns cash + upi for split mode", () => {
    expect(getSettlementAmount(makeDraft({ paymentMode: "split", cashAmount: 300, upiAmount: 200 }))).toBe(500);
  });

  it("returns 0 for split with both amounts at 0", () => {
    expect(getSettlementAmount(makeDraft({ paymentMode: "split", cashAmount: 0, upiAmount: 0 }))).toBe(0);
  });
});

// ─── computeSettlement ───────────────────────────────────────────────────────

describe("computeSettlement — validation", () => {
  it("rejects zero settlement amount", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ cashAmount: 0 }));
    expect(result.error).toMatch(/greater than zero/i);
    expect(result.paymentRecords).toHaveLength(0);
  });

  it("rejects settlement exceeding amount due", () => {
    const result = computeSettlement(0, 300, 500, makeDraft({ cashAmount: 400 }));
    expect(result.error).toMatch(/exceeds/i);
    expect(result.newAmountPaid).toBe(0);
  });

  it("accepts settlement within tolerance of amount due", () => {
    const result = computeSettlement(0, 300, 500, makeDraft({ cashAmount: 300 + PAYMENT_TOLERANCE / 2 }));
    expect(result.error).toBeNull();
  });
});

describe("computeSettlement — full settlement", () => {
  it("flips status to issued when fully paid", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ cashAmount: 500 }));
    expect(result.error).toBeNull();
    expect(result.newStatus).toBe("issued");
    expect(result.newAmountDue).toBe(0);
    expect(result.newAmountPaid).toBe(500);
  });

  it("flips to issued when remainder is within tolerance", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ cashAmount: 500 - PAYMENT_TOLERANCE / 2 }));
    expect(result.newStatus).toBe("issued");
  });

  it("creates one cash payment record", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ paymentMode: "cash", cashAmount: 500 }));
    expect(result.paymentRecords).toEqual([{ mode: "cash", amount: 500 }]);
  });

  it("creates one upi payment record", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ paymentMode: "upi", upiAmount: 500 }));
    expect(result.paymentRecords).toEqual([{ mode: "upi", amount: 500 }]);
  });
});

describe("computeSettlement — partial settlement", () => {
  it("keeps status pending when amount due remains", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ cashAmount: 200 }));
    expect(result.newStatus).toBe("pending");
    expect(result.newAmountPaid).toBe(200);
    expect(result.newAmountDue).toBeCloseTo(300);
  });

  it("accumulates correctly across multiple partial settlements", () => {
    const first = computeSettlement(0, 500, 500, makeDraft({ cashAmount: 200 }));
    expect(first.newStatus).toBe("pending");
    const second = computeSettlement(first.newAmountPaid, first.newAmountDue, 500, makeDraft({ cashAmount: 300 }));
    expect(second.newStatus).toBe("issued");
    expect(second.newAmountDue).toBe(0);
    expect(second.newAmountPaid).toBeCloseTo(500);
  });

  it("does not let newAmountDue go below 0", () => {
    const result = computeSettlement(499, 1, 500, makeDraft({ cashAmount: 1 + PAYMENT_TOLERANCE / 2 }));
    expect(result.newAmountDue).toBe(0);
  });
});

describe("computeSettlement — split settlement", () => {
  it("creates two payment records for split mode", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ paymentMode: "split", cashAmount: 300, upiAmount: 200 }));
    expect(result.error).toBeNull();
    expect(result.paymentRecords).toContainEqual({ mode: "cash", amount: 300 });
    expect(result.paymentRecords).toContainEqual({ mode: "upi", amount: 200 });
    expect(result.paymentRecords).toHaveLength(2);
  });

  it("omits zero-amount records in split", () => {
    const result = computeSettlement(0, 500, 500, makeDraft({ paymentMode: "split", cashAmount: 500, upiAmount: 0 }));
    expect(result.paymentRecords).toHaveLength(1);
    expect(result.paymentRecords[0].mode).toBe("cash");
  });
});

describe("computeSettlement — with prior partial payment", () => {
  it("settles remaining balance on a partially-paid deferred bill", () => {
    // Bill: total=500, already paid 200 upfront at checkout, due=300
    const result = computeSettlement(200, 300, 500, makeDraft({ paymentMode: "upi", upiAmount: 300 }));
    expect(result.error).toBeNull();
    expect(result.newAmountPaid).toBeCloseTo(500);
    expect(result.newAmountDue).toBe(0);
    expect(result.newStatus).toBe("issued");
  });

  it("rejects settlement exceeding remaining due even if less than total", () => {
    // Bill: total=500, amountPaid=400, amountDue=100
    const result = computeSettlement(400, 100, 500, makeDraft({ cashAmount: 150 }));
    expect(result.error).toMatch(/exceeds/i);
    expect(result.newAmountPaid).toBe(400);
  });
});
