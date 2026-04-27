## Why

The Payment Mix breakdown (Cash · UPI) shown in the analytics report is systematically lower than Gross Revenue whenever deferred bills have an upfront amount collected. The root cause is that `paymentModeTotals` is computed exclusively from payment records belonging to bills with `status === "issued"`, while `grossRevenue` also counts upfront payments on `status === "pending"` bills via `deferredCollected`. This creates a visible, unexplained gap (e.g., ₹7,562 Gross Revenue vs ₹7,462 Cash + UPI = ₹100 gap), which erodes operator trust in the analytics figures.

## What Changes

- **Payment Mix now includes pending-bill upfront payments** — when a deferred bill has a partial upfront payment collected at checkout (e.g., ₹100 cash), that ₹100 is reflected in the Cash/UPI breakdown, making `Cash + UPI == Gross Revenue` at all times.
- **No change to Gross Revenue or any other KPI** — only the Payment Mix totals change to align with the existing, correct revenue figure.
- **New and updated tests** — billing and utils tests verify the alignment under deferred + split + cash/UPI scenarios.

## Capabilities

### New Capabilities

- `payment-mix-alignment`: Payment Mix (Cash + UPI totals) always equals Gross Revenue by including upfront payments from pending/deferred bills, not just fully-settled bills.

### Modified Capabilities

_(none — no existing spec covers Payment Mix computation)_

## Impact

- `src/App.tsx` — lines 3397–3402: extend `issuedBillPayments` lookup to also cover pending bills with `amountPaid > 0`.
- `src/panels/ReportsPanel.tsx` — display is unchanged; it just receives corrected totals.
- Tests: new cases in `billing.test.ts` or a new analytics-focused test file.
