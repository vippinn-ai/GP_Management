## 1. Core Logic Fix — `buildBillPreview` (`utils.ts`)

- [x] 1.1 Change `isZeroTotal` in `buildBillPreview` return value from `roundedTotal <= 0` to `subtotal <= 0`
- [x] 1.2 Verify the change does not affect any other consumer of `buildBillPreview` (search all call sites)

## 2. Core Logic Fix — `buildCheckoutPaymentResult` (`billing.ts`)

- [x] 2.1 Guard the non-split/non-deferred payment record push: only push when `total > 0`

## 3. Bill Replacement Default Payment Mode (`App.tsx`)

- [x] 3.1 In `openBillReplacement`, change `paymentMode: bill.paymentMode` to default `"cash"` when original paymentMode is `"deferred"`

## 4. Tests — `utils.test.ts`

- [x] 4.1 Add test: `buildBillPreview` with full line discount → `isZeroTotal = false`, `total = 0`, `subtotal > 0`
- [x] 4.2 Add test: `buildBillPreview` with full bill-level discount → `isZeroTotal = false`, `total = 0`
- [x] 4.3 Add test: `buildBillPreview` with empty lines → `isZeroTotal = true` (existing behaviour confirmed)
- [x] 4.4 Add test: `buildBillPreview` with zero-price items → `isZeroTotal = true`
- [x] 4.5 Add test: LTP-win scenario — session charge line fully discounted → `isZeroTotal = false`

## 5. Tests — `billing.test.ts`

- [x] 5.1 Add test: `buildCheckoutPaymentResult` cash mode, total = 0 → `paymentRecords` is empty
- [x] 5.2 Add test: `buildCheckoutPaymentResult` upi mode, total = 0 → `paymentRecords` is empty
- [x] 5.3 Add test: `buildCheckoutPaymentResult` split mode, total = 0 → `paymentRecords` is empty
- [x] 5.4 Add test: `buildCheckoutPaymentResult` cash mode, total = 0 → `status = "issued"`, `amountPaid = 0`, `amountDue = 0`
- [x] 5.5 Verify all existing `buildCheckoutPaymentResult` tests still pass after the guard change

## 6. Run Full Test Suite & Verify

- [x] 6.1 Run `npm test` (or `npx vitest run`) and confirm all tests pass with no regressions
- [x] 6.2 Review test output for any unexpected failures in `billing.test.ts`, `utils.test.ts`, `pricing.test.ts`, `cigarette.test.ts`
