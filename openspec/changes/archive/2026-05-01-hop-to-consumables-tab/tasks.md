## 1. Post-Hop Continuation UI

- [x] 1.1 Add post-hop continuation mode state with gaming as the default.
- [x] 1.2 Update the post-hop modal title/body so gaming mode keeps the existing start-session flow.
- [x] 1.3 Add consumables mode in the same modal with hopped customer details prefilled.
- [x] 1.4 Wire consumables mode to open/select the existing customer tab and route staff to the Sale panel.

## 2. Customer-Tab Combined Billing

- [x] 2.1 Populate `checkoutState.hoppedSessionIds` when customer-tab checkout starts.
- [x] 2.2 Show previous unbilled hopped sessions during customer-tab checkout with the same selectable behavior as session checkout.
- [x] 2.3 Include selected hopped session lines when building customer-tab checkout previews and final bills.
- [x] 2.4 Ensure deselected hopped sessions remain unbilled/hopped after customer-tab billing.

## 3. Inventory Reservation Review

- [x] 3.1 Verify customer-tab availability checks account for open customer-tab reservations.
- [x] 3.2 Fix customer-tab reservation/freezing behavior if verification shows non-reusable stock can be overcommitted.

## 4. Verification

- [x] 4.1 Add or update tests for customer-tab checkout with selected and deselected hopped sessions.
- [x] 4.2 Run the project build and targeted tests; document unrelated full-suite failures.
