## 1. Fix Payment Mix computation (`App.tsx`)

- [x] 1.1 Compute `pendingBillsWithUpfront` from `filteredBills` where `status === "pending" && amountPaid > 0`
- [x] 1.2 Build `revenueCountedBillIds` as the union of `issuedBills` IDs and `pendingBillsWithUpfront` IDs
- [x] 1.3 Replace `issuedBillIds` / `issuedBillPayments` with `revenueCountedBillIds` / `revenueCountedPayments` in the `paymentModeTotals` computation (lines 3397–3402)
- [x] 1.4 Verify `Cash + UPI == grossRevenue` in the updated render path (trace through the formulas)

## 2. Tests

- [x] 2.1 Add unit test: deferred bill with upfront cash payment → payment mix cash total includes the upfront amount
- [x] 2.2 Add unit test: fully deferred bill (amountPaid = 0) → payment mix is unaffected
- [x] 2.3 Add unit test: settled deferred bill (status "issued") → counted only once, no double-count
- [x] 2.4 Add unit test: all-cash issued bills only → payment mix unchanged (regression guard)

## 3. Run Full Test Suite & Verify

- [x] 3.1 Run `npx vitest run` — all tests must pass with zero regressions
- [x] 3.2 Review that no existing billing or utils tests broke
