import type { BillPaymentMode, BillStatus, PaymentMode, SettlementDraft } from "./types";

export const PAYMENT_TOLERANCE = 0.01;

export interface PaymentRecord {
  mode: PaymentMode;
  amount: number;
}

export interface CheckoutPaymentResult {
  amountPaid: number;
  amountDue: number;
  status: BillStatus;
  paymentRecords: PaymentRecord[];
}

export interface SettlementResult {
  newAmountPaid: number;
  newAmountDue: number;
  newStatus: BillStatus;
  paymentRecords: PaymentRecord[];
  error: string | null;
}

/**
 * Returns a validation error message, or null if the payment inputs are valid.
 */
export function validateCheckoutPayment(
  paymentMode: BillPaymentMode,
  splitCashAmount: number,
  splitUpiAmount: number,
  collectAmount: number,
  total: number
): string | null {
  if (paymentMode === "split") {
    const splitTotal = splitCashAmount + splitUpiAmount;
    if (Math.abs(splitTotal - total) > PAYMENT_TOLERANCE) {
      return `Split amounts (₹${splitTotal.toFixed(2)}) must equal the bill total (₹${total.toFixed(2)}).`;
    }
  }
  if (paymentMode === "deferred") {
    if (collectAmount < 0) {
      return "Upfront amount cannot be negative.";
    }
    if (collectAmount > total + PAYMENT_TOLERANCE) {
      return "Upfront amount cannot exceed the bill total.";
    }
  }
  return null;
}

/**
 * Computes the bill's payment state and the payment records to create at checkout.
 * Assumes inputs have already been validated with validateCheckoutPayment.
 */
export function buildCheckoutPaymentResult(
  paymentMode: BillPaymentMode,
  splitCashAmount: number,
  splitUpiAmount: number,
  collectAmount: number,
  collectMode: PaymentMode,
  total: number
): CheckoutPaymentResult {
  const isDeferred = paymentMode === "deferred";
  const amountPaid = isDeferred ? collectAmount : total;
  const amountDue = Math.max(0, total - amountPaid);
  const status: BillStatus = amountDue > PAYMENT_TOLERANCE ? "pending" : "issued";

  const paymentRecords: PaymentRecord[] = [];
  if (paymentMode === "split") {
    if (splitCashAmount > 0) paymentRecords.push({ mode: "cash", amount: splitCashAmount });
    if (splitUpiAmount > 0) paymentRecords.push({ mode: "upi", amount: splitUpiAmount });
  } else if (paymentMode === "deferred") {
    if (amountPaid > 0) paymentRecords.push({ mode: collectMode, amount: amountPaid });
  } else {
    paymentRecords.push({ mode: paymentMode as PaymentMode, amount: total });
  }

  return { amountPaid, amountDue, status, paymentRecords };
}

export function getSettlementAmount(draft: SettlementDraft): number {
  if (draft.paymentMode === "split") return draft.cashAmount + draft.upiAmount;
  if (draft.paymentMode === "cash") return draft.cashAmount;
  return draft.upiAmount;
}

/**
 * Computes the result of applying a settlement payment to a pending bill.
 * Returns an error string on invalid input instead of throwing.
 * Operates on current bill state (not stale snapshots) — call this inside mutateAppData.
 */
export function computeSettlement(
  currentAmountPaid: number,
  currentAmountDue: number,
  total: number,
  draft: SettlementDraft
): SettlementResult {
  const settlementAmount = getSettlementAmount(draft);
  // Base fields for error returns — computeSettlement is only called on pending bills so "pending" is always the unchanged status.
  const noChange = {
    newAmountPaid: currentAmountPaid,
    newAmountDue: currentAmountDue,
    newStatus: "pending" as BillStatus,
    paymentRecords: [] as PaymentRecord[],
  };

  if (settlementAmount <= 0) {
    return { ...noChange, error: "Settlement amount must be greater than zero." };
  }
  if (settlementAmount > currentAmountDue + PAYMENT_TOLERANCE) {
    return {
      ...noChange,
      error: `Settlement amount (₹${settlementAmount.toFixed(2)}) exceeds amount due (₹${currentAmountDue.toFixed(2)}).`
    };
  }

  const newAmountPaid = currentAmountPaid + settlementAmount;
  const newAmountDue = Math.max(0, total - newAmountPaid);
  const newStatus: BillStatus = newAmountDue < PAYMENT_TOLERANCE ? "issued" : "pending";

  const paymentRecords: PaymentRecord[] = [];
  if (draft.paymentMode === "split") {
    if (draft.cashAmount > 0) paymentRecords.push({ mode: "cash", amount: draft.cashAmount });
    if (draft.upiAmount > 0) paymentRecords.push({ mode: "upi", amount: draft.upiAmount });
  } else if (draft.paymentMode === "cash") {
    paymentRecords.push({ mode: "cash", amount: draft.cashAmount });
  } else {
    paymentRecords.push({ mode: "upi", amount: draft.upiAmount });
  }

  return { newAmountPaid, newAmountDue, newStatus, paymentRecords, error: null };
}
