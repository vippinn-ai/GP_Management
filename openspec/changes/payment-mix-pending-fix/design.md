## Context

`grossRevenue` (App.tsx:3330–3336) is computed as:
```
grossRevenue = issuedRevenue + deferredCollected
```
where `deferredCollected = sum of pending bills' amountPaid (where amountPaid > 0)`.

`paymentModeTotals` (App.tsx:3397–3402) is computed as:
```
issuedBillIds = set of bill IDs from issuedBills (status === "issued")
issuedBillPayments = payments WHERE billId IN issuedBillIds
paymentModeTotals.cash = sum of issuedBillPayments WHERE mode = "cash"
paymentModeTotals.upi  = sum of issuedBillPayments WHERE mode = "upi"
```

When a deferred bill has an upfront payment collected at checkout (e.g., ₹100 cash), a payment record `{ mode: "cash", amount: 100 }` is created in `appData.payments`. But the bill's status remains `"pending"`, so it is excluded from `issuedBillIds`. Result: the ₹100 is in `grossRevenue` (via `deferredCollected`) but NOT in `paymentModeTotals`, producing a visible gap of exactly the upfront amount.

## Goals / Non-Goals

**Goals:**
- Make `paymentModeTotals.cash + paymentModeTotals.upi == grossRevenue` always.
- Include upfront payment records from pending/deferred bills in the Payment Mix breakdown.

**Non-Goals:**
- Changing how `grossRevenue` is computed.
- Changing the "Outstanding (Pending)" or "Deferred Outstanding" KPIs.
- Modifying the settlement flow or bill statuses.

## Decisions

### Decision: Extend the payment lookup to include pending bills with upfront payments

**Chosen approach:**
```ts
// Before (only issued bills):
const issuedBillIds = new Set(issuedBills.map((bill) => bill.id));
const issuedBillPayments = appData.payments.filter((p) => issuedBillIds.has(p.billId));

// After (issued + pending-with-upfront):
const pendingBillsWithUpfront = filteredBills.filter((b) => b.status === "pending" && b.amountPaid > 0);
const revenueCountedBillIds = new Set([
  ...issuedBills.map((b) => b.id),
  ...pendingBillsWithUpfront.map((b) => b.id)
]);
const revenueCountedPayments = appData.payments.filter((p) => revenueCountedBillIds.has(p.billId));
const paymentModeTotals = {
  cash: sumBy(revenueCountedPayments.filter((p) => p.mode === "cash"), (p) => p.amount),
  upi:  sumBy(revenueCountedPayments.filter((p) => p.mode === "upi"),  (p) => p.amount)
};
```

**Why this over alternatives:**
- The simplest possible change: extend the bill ID set by one category that already participates in `grossRevenue`.
- Alternative considered: recompute Payment Mix from `bill.amountPaid` + `bill.paymentMode`. Rejected — pending bills can have `collectMode` (cash/upi) separate from `paymentMode` ("deferred"), so this requires storing the collectMode on the bill itself. Using the existing payment records is the correct source of truth.
- Alternative considered: store `collectModeTotals` at checkout. Rejected — the payment records already exist and are the canonical record.

**Double-counting guard:** When a pending bill is later settled and transitions to `"issued"`, it moves into `issuedBills`. Its full payment records (upfront + settlement) are then included via `issuedBillIds`. We ensure no double-count because we only add pending bills that are STILL pending (status check is live). Once settled, the bill is no longer in `pendingBillsWithUpfront`.

## Risks / Trade-offs

- [Risk: Same payment record counted twice when a pending bill settles mid-session] → Not possible: `filteredBills` status is read at render time; a settled bill will be "issued" not "pending".
- [Risk: Performance] → The extra Set spread and filter are O(n) over `filteredBills` and `appData.payments`, identical to the existing code. Negligible.

## Migration Plan

No data migration. Client-side render change only. Deploy with a standard frontend build.
