## Context

`buildBillPreview` in `utils.ts` computes `isZeroTotal: roundedTotal <= 0`. This flag is used in two places: (1) the "Issue Bill" / "Issue Replacement Bill" button's `disabled` attribute in the checkout modal, and (2) an early-return guard inside `finalizeCheckout`. Together they block any bill whose rounded total is ≤ 0, regardless of whether items exist.

The problem: a 100 % discount on a session charge (e.g. LTP win) or an admin-applied full line/bill discount legitimately produces a ₹0 bill that should be issuable. The same guard also fires when a replacement bill is opened for a legacy bill that was previously issued at ₹0 (before the guard was introduced).

A secondary bug exists in `openBillReplacement`: the checkout state is seeded with `paymentMode: bill.paymentMode`. If the original was a deferred bill that was later settled (status becomes `"issued"`), the replacement inherits `"deferred"` — a mode that is intentionally hidden in the replacement checkout UI, leading to a silent/invisible mode mismatch.

A third, minor issue: `buildCheckoutPaymentResult` unconditionally pushes a `{ mode, amount: 0 }` payment record when total is 0 and mode is cash or UPI, polluting the payments table with zero-amount records.

## Goals / Non-Goals

**Goals:**
- Allow a bill with `subtotal > 0` and `total = 0` (discount-driven) to be issued successfully.
- Stop `buildCheckoutPaymentResult` from creating ₹0 payment records.
- Default replacement bill payment mode to `"cash"` when the original was `"deferred"`.
- Preserve the existing block for genuinely empty bills (`subtotal ≤ 0`).
- Full test coverage for all new scenarios.

**Non-Goals:**
- Adding a UI warning or confirmation step before issuing a ₹0 bill (not requested).
- Changing how discounts are computed or capped (`getDiscountAmount` is correct and unchanged).
- Changing the `zero-price-item` inline warning on the consumable-add path.

## Decisions

### Decision 1: Change `isZeroTotal` to track `subtotal ≤ 0` instead of `roundedTotal ≤ 0`

**Chosen**: `isZeroTotal: subtotal <= 0`

`subtotal` is the raw sum of `quantity × unitPrice` across all lines before any discount. It is positive whenever at least one item with a non-zero price exists. Discount-driven zeros (LTP win, manual full discount) have `subtotal > 0`, so `isZeroTotal` becomes `false` and the bill is allowed. Genuinely empty bills (`subtotal = 0`) remain blocked.

**Alternative considered**: Keep `isZeroTotal` as-is and add a separate `isDiscountDrivenZero` flag, branching in both the button and the guard. Rejected — two flags for the same UI gating point is more complex with no benefit. The single flag just needs a better definition.

**Alternative considered**: Remove the guard entirely and rely on users not issuing empty bills. Rejected — the guard is valuable for catching operator error (checkout with no items).

### Decision 2: No ₹0 payment records

In `buildCheckoutPaymentResult`, the non-split/non-deferred branch unconditionally pushes `amount: total`. Guard it with `if (total > 0)` so zero-total bills emit an empty `paymentRecords` array. The bill is still `status: "issued"` with `amountPaid = 0, amountDue = 0` — the payment record just doesn't exist (consistent with how split and deferred already handle zero amounts).

### Decision 3: Replacement payment mode default

In `openBillReplacement`, change:
```ts
paymentMode: bill.paymentMode
```
to:
```ts
paymentMode: bill.paymentMode === "deferred" ? "cash" : bill.paymentMode
```

This silently corrects the one case that breaks the replacement UI. All other payment modes (`"cash"`, `"upi"`, `"split"`) are valid in replacement mode and are preserved.

## Risks / Trade-offs

- **Intentional empty-bill bypass** — an operator could add a ₹0 session-charge line and issue it (since `subtotal = 0` → still blocked). Risk is low; the existing item-zero-price warning on the consumable-add path already surfaces this.
- **Legacy zero-total bills** — bills issued before the zero-price guard was introduced can now be replaced (no longer blocked by `isZeroTotal`). This is the desired behaviour.
- **Payment records for zero bills** — removing the ₹0 payment record means no payment row exists for these bills. Dashboard/reporting queries that join `bills` and `payments` to reconcile totals will still work correctly because `amountPaid = 0` is on the bill row itself.

## Migration Plan

No data migration required. Changes are purely in application logic. Existing issued bills are unaffected. The three changed files (`utils.ts`, `billing.ts`, `App.tsx`) are all client-side; deploy is a normal frontend build + release.
