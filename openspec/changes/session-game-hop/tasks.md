## 1. Type System Updates

- [x] 1.1 Add `"hopped"` to the `closeDisposition` union in `Session` type (`types.ts`)
- [x] 1.2 Add optional `hoppedSessionIds?: string[]` field to `CheckoutState` in `types.ts` (or inline in App.tsx)

## 2. Game Hop Close Flow (`App.tsx` — checkout modal + session close)

- [x] 2.1 Add "Close for game hop — bill later" option inside the session checkout modal (new radio or button)
- [x] 2.2 When hop option is selected, hide payment fields and replace "Issue Bill" with "Confirm Game Hop" button
- [x] 2.3 Implement `hopSession(sessionId)` function: closes session with `status = "closed"`, `closeDisposition = "hopped"`, `endedAt = effectiveClosedAt`, no bill created, station released, audit log added
- [x] 2.4 Wire the "Confirm Game Hop" button to `hopSession`

## 3. Start-Session Customer Pre-fill (`App.tsx`)

- [x] 3.1 Add helper `getMostRecentHoppedSession()` that returns the most recent session where `closeDisposition === "hopped" && !closedBillId`, sorted by `endedAt` descending
- [x] 3.2 When the start-session form opens (or the station is selected), if a recent hopped session exists, pre-fill `startSessionDraft.customerName`, `.customerPhone`, `.customerId`

## 4. Hopped Sessions Detection at Checkout (`App.tsx`)

- [x] 4.1 Add helper `getUnbilledHoppedSessionsForCustomer(customerName, customerPhone)` that filters sessions by `closeDisposition === "hopped" && !closedBillId` and matches by phone (exact) or name (case-insensitive)
- [x] 4.2 When `openSessionCheckout` is called, call this helper and store matches in `checkoutState.hoppedSessionIds` (pre-selected if matches found)
- [x] 4.3 In the checkout modal, render a "Previous unbilled sessions" section showing matched hopped sessions as a checkable list (station name, duration, estimated charge per session)
- [x] 4.4 Wire checkbox toggle to update `checkoutState.hoppedSessionIds`

## 5. Combined Bill Preview and Issuance (`App.tsx` + `utils.ts`)

- [x] 5.1 In the checkout lines computation (render section), when `hoppedSessionIds` is non-empty, call `getSessionCheckoutLines` for each hopped session (using `session.endedAt` as effective end) and prepend those lines to the current session's lines
- [x] 5.2 Verify `buildBillPreview` receives the combined lines and produces a correct combined total
- [x] 5.3 In `finalizeCheckout`, after issuing the bill, iterate over `checkoutState.hoppedSessionIds` and for each: set `targetSession.closedBillId = billId`, `targetSession.closeDisposition = "billed"`, add audit log

## 6. Tests

- [x] 6.1 Add test: `getHoppedSessionsForCustomer` returns correct sessions matched by phone
- [x] 6.2 Add test: `getHoppedSessionsForCustomer` returns correct sessions matched by name (case-insensitive)
- [x] 6.3 Add test: `getHoppedSessionsForCustomer` excludes already-billed hopped sessions (`closedBillId` set)
- [x] 6.4 Add test: combined bill preview — `buildBillPreview` with lines from two sessions has correct subtotal
- [x] 6.5 Add test: hopped session with items — items are included as line items in combined bill

## 7. Run Full Test Suite & Verify

- [x] 7.1 Run `npx vitest run` — all tests must pass, zero regressions
- [x] 7.2 Manually verify: start session → hop → start new session (customer pre-fills) → checkout showing previous session → issue combined bill → both sessions show `closeDisposition = "billed"`
