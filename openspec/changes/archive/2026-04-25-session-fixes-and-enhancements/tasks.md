## 1. LTP Group Default (smallest, no risk)

- [x] 1.1 In `src/App.tsx` line ~687, change the `startSessionDraft` initial playMode from `station?.ltpEnabled ? "solo" : "group"` to always `"group"`
- [x] 1.2 Verify the session creation flow at line ~970 (`sessionPlayMode`) still correctly passes the user-selected playMode rather than hardcoding solo
- [x] 1.3 Test: open start-session dialog on an LTP station, confirm "Group" is pre-selected; verify solo can still be chosen manually

## 2. Zero-Price Bill Guard

- [x] 2.1 In `src/utils.ts` `buildBillPreview()`, add a computed field `isZeroTotal: boolean` (= `roundedTotal <= 0`) to the returned preview object
- [x] 2.2 In `src/App.tsx` `finalizeCheckout()`, add early guard: `if (preview.isZeroTotal) throw new UserFacingError("Bill total is ₹0 — add items or remove discounts before issuing")`
- [x] 2.3 Find the "Issue Bill" button render location in `App.tsx` (~line 4290) and disable it when `preview.isZeroTotal` is true, with tooltip text
- [x] 2.4 In the consumable item add handler, add an inline warning when the item's `salePrice === 0` (do not block, just warn)
- [x] 2.5 Add a SQL audit query as a comment near `finalizeCheckout`: `SELECT * FROM app_data WHERE data->'bills' @> '[{"total":0}]'` (adapt to actual schema)
- [x] 2.6 Test: set an item price to 0, add to session, confirm warning shown; attempt to issue bill, confirm blocked with error message

## 3. Pause Visual Indicators

- [x] 3.1 In `src/styles.css`, add/update `.station-card.is-paused` rule with red border (`border: 2px solid #ef4444`) and light red background tint
- [x] 3.2 Add CSS keyframe animation `pauseOvertimePulse` (red glow pulse, ~2s cycle) and apply it via `.station-card.is-paused-overtime` class
- [x] 3.3 In `src/panels/DashboardPanel.tsx`, create a custom hook `usePauseOvertime(session, pauseLogs)` that returns `{ elapsedMs, isOvertime }` using `useEffect` + `setInterval` (update every 30s) driven by the open pause log's `pausedAt`
- [x] 3.4 Apply the hook result in the station card render: append `is-paused-overtime` class when `isOvertime` is true; show elapsed pause duration text (e.g., "Paused 12m") on the card
- [x] 3.5 Ensure the interval is cleared on unmount and when the session resumes (status ≠ "paused")
- [x] 3.6 Test: pause a session, confirm card turns red immediately; wait/mock 10+ minutes, confirm animation appears; resume, confirm both clear

## 4. Pause Interval Editing

- [x] 4.1 In `src/types.ts`, confirm `SessionPauseLog` interface (lines 54-59) has `id`, `sessionId`, `pausedAt`, `resumedAt?` — no changes needed if already correct
- [x] 4.2 In `src/App.tsx`, add handler `editPauseLogEntry(logId, patch: Partial<Pick<SessionPauseLog, 'pausedAt' | 'resumedAt'>>)` that validates timestamps and calls `mutateAppData`
- [x] 4.3 Add handler `deletePauseLogEntry(logId)` that removes the entry from `sessionPauseLogs`, removes logId from `session.pauseLogIds`, and sets `session.status = "running"` if the deleted entry was the open pause
- [x] 4.4 In the session details modal render (App.tsx ~line 3751), add a "Pause History" section that maps `session.pauseLogIds` to their log entries and renders each as a row with formatted datetimes, edit pencil icon, delete icon
- [x] 4.5 Implement inline edit row state: clicking the edit pencil on a row shows datetime inputs for `pausedAt` and `resumedAt`; Save button calls `editPauseLogEntry`; Cancel dismisses
- [x] 4.6 Implement delete confirmation: clicking the delete icon shows a confirm dialog ("Delete this pause entry?") before calling `deletePauseLogEntry`
- [x] 4.7 Add validation in `editPauseLogEntry`: reject if `pausedAt < session.startTime`, `resumedAt <= pausedAt`, or intervals overlap after edit
- [x] 4.8 Test: create a session, pause and resume it twice; open session modal, edit a `pausedAt`, confirm billing time recalculates; delete one entry, confirm it disappears and session status is correct

## 5. Concurrent Update Handling (Retry UX)

- [x] 5.1 In `src/App.tsx`, add a `pendingRetryAction` ref (`useRef<(() => Promise<void>) | null>(null)`) at the top-level component
- [x] 5.2 Modify `saveRemoteSnapshot()` (~line 307): when a version-conflict error is caught, store the current action in `pendingRetryAction.current` and set a new state variable `showRetryBanner: true`
- [x] 5.3 Add a non-dismissable retry banner component: "Another device updated this data. Your changes were not saved. [Retry]". Render it when `showRetryBanner` is true
- [x] 5.4 Retry button onClick: call `pendingRetryAction.current?.()`, then clear both `pendingRetryAction.current` and `showRetryBanner`
- [x] 5.5 If the retry also fails with a version conflict, show a dismissable error "Could not save — please check the latest data and try again" with no further automatic retry
- [x] 5.6 Ensure `pendingRetryAction` callbacks are pure functions of `appData` (they read from the ref after reload, not from a stale closure); document this pattern in a code comment
- [x] 5.7 Change the existing error message text from "Remote data changed in another browser. Please retry after the latest data loads." to match the new operator-friendly copy in the spec
- [x] 5.8 Test: simulate a conflict (open two tabs, modify in tab 2, then save in tab 1); confirm retry banner appears; click Retry, confirm action succeeds

## 6. Inventory Reservation

- [x] 6.1 In `src/types.ts`, add `"session_reservation"` and `"session_reservation_void"` to the `StockMovementReason` union type
- [x] 6.2 In `src/App.tsx` `addItemToSession()` handler (~line 1084): write a `StockMovement` with `type: "session_reservation"` when a non-reusable item is added (audit trail; stockQty not decremented to avoid double-counting)
- [x] 6.3 Modify `removeItemFromSession`: write a compensating `StockMovement` with `type: "session_reservation_void"` when a non-reusable item is removed
- [x] 6.4 Update InventoryPanel to display `getAvailableStock(item)` (effective stock = stockQty - session reservations) instead of raw `stockQty`, adding "(N in sessions)" annotation
- [x] 6.5 Write a one-time migration function guarded by `localStorage` flag that creates retrospective `session_reservation` audit movements for items already in open sessions at deploy time
- [x] 6.6 Call migration on login (`activeUserId` change), guarded by the localStorage flag so it only runs once per device
- [x] 6.7 Test: add item to session, check stockQty decremented immediately; remove item, check stockQty restored; issue bill, check stock movement reason is "sale" with no double decrement; check unlimited-stock items (stockQty = -1) are unaffected
