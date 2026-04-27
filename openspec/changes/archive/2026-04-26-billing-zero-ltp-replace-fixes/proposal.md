## Why

Three related billing flows are broken: issuing an LTP-win bill (game charge fully discounted), issuing bills for LTP sessions in some edge cases, and replacing a bill when the replacement preview produces a ₹0 total. All three trace back to the same overly-strict zero-total guard that blocks discount-driven zero bills, plus a secondary bug where bill replacements can silently inherit an invalid payment mode from the original.

## What Changes

- **Allow discount-driven zero bills** — when `subtotal > 0` but applied discounts bring `total` to ₹0, the bill SHALL be issuable. The guard SHALL only block truly empty bills (`subtotal ≤ 0`).
- **LTP win billing** — an LTP-win session (full game-charge discount, no consumables) results in a ₹0 bill that is now allowed. No payment record is created; the bill is issued with `amountPaid = 0`, `amountDue = 0`.
- **LTP lost billing** — no regression; all scenarios where the session charge is non-zero continue to work. Edge case where `chargeSummary.subtotal = 0` (no pricing rule) is still blocked (correctly).
- **Bill replacement** — a replacement whose items + discounts resolve to ₹0 (e.g., replacing a legacy zero-total bill) is no longer blocked by the zero-total guard, since `subtotal > 0`.
- **Replace bill payment mode inheritance** — if the original bill's `paymentMode` was `"deferred"` (possible after a fully-settled deferred bill), the replacement checkout defaults to `"cash"` instead of carrying the unsupported `"deferred"` mode into the replacement form.
- **Zero payment records** — `buildCheckoutPaymentResult` no longer pushes a ₹0 cash/UPI record when total is ₹0 in non-split, non-deferred modes.
- **Test coverage** — new and updated test cases in `utils.test.ts` and `billing.test.ts` covering all scenarios above.

## Capabilities

### New Capabilities

- `discount-driven-zero-bill`: Discount-driven zero bills (subtotal > 0, total = 0 after discounts) are issuable; covers LTP-win, full-discount sessions, full-discount tabs, and replacements.

### Modified Capabilities

- `zero-price-bill-guard`: The "block zero-total bill" requirement changes: the guard now targets only empty bills (`subtotal ≤ 0`) rather than zero-rounded-total bills. The LTP-win and full-discount scenarios now fall under `discount-driven-zero-bill` instead.

## Impact

- `src/utils.ts` — `buildBillPreview`: change `isZeroTotal` computation from `roundedTotal <= 0` to `subtotal <= 0`.
- `src/billing.ts` — `buildCheckoutPaymentResult`: guard the non-split/non-deferred payment record push with `total > 0`.
- `src/App.tsx` — `openBillReplacement`: default `paymentMode` to `"cash"` when original bill's mode was `"deferred"`.
- `src/utils.test.ts` — new `buildBillPreview` test cases for discount-driven zero scenarios.
- `src/billing.test.ts` — new `buildCheckoutPaymentResult` test cases for zero-total bills.
