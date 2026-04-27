## Why

Customers frequently want to play multiple games back-to-back (e.g., PlayStation → 8 Ball Pool → Foosball) without stopping to pay between games. The current flow forces staff to close each session and issue a separate bill before the station can be reused, creating friction and requiring mid-session payment. A "game hop" feature allows staff to close a session without billing, release the station immediately, and then issue a single combined bill that includes all session charges and consumables when the customer finally pays.

## What Changes

- **New `closeDisposition: "hopped"` value** — a session can be closed with `closeDisposition = "hopped"` (no bill, station released), preserving all charges and items for later combined billing.
- **"Game Hop" option in the session checkout modal** — inside the existing checkout flow, a new "Close for game hop — bill later" option allows staff to close a session without issuing a bill.
- **Customer auto-fill from previous hopped session** — when starting a new session after a hop, the start-session form pre-fills the customer name, phone, and customer ID from the most recently hopped session for that station's last customer.
- **Hopped sessions shown at final checkout** — when the checkout modal opens for any session, the system searches for `closeDisposition === "hopped"` sessions matching the current customer (by phone or name) and displays them for staff selection.
- **Combined bill generation** — when staff selects hopped sessions at checkout, the issued bill includes line items from all selected hopped sessions (session charges + consumable items) plus the current session, with each session's lines clearly labeled.
- **Hopped session linkage after billing** — after the combined bill is issued, each included hopped session gets `closedBillId` set and `closeDisposition` updated to `"billed"`, closing the billing loop.
- **New `SessionCloseDisposition` type value** — `"hopped"` is added to the existing `"billed" | "rejected"` union.

## Capabilities

### New Capabilities

- `session-game-hop`: Closing a session without billing ("game hop") and combining multiple sessions into one final bill at checkout.

### Modified Capabilities

_(none — existing session close and checkout specs don't cover multi-session billing)_

## Impact

- `src/types.ts` — add `"hopped"` to `closeDisposition` union type.
- `src/App.tsx` — `openSessionCheckout` / checkout modal: add "Game Hop" close path; detect hopped sessions at checkout; extend `finalizeCheckout` to process combined session lines and update hopped sessions.
- `src/utils.ts` — `getSessionCheckoutLines`: no changes needed (already generates lines per session); new helper `getHoppedSessionsForCustomer`.
- `src/App.tsx` — `CheckoutState` type (or `types.ts`): add `hoppedSessionIds?: string[]` field.
- Tests: new test cases covering hop close, combined bill preview, and hopped session linkage.
