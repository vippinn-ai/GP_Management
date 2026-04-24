## Context

The system is a single-page React app backed by Supabase. All application state lives in a single `AppData` blob that is read, mutated in memory, and written back with optimistic version locking (a `version` integer column checked in the SQL WHERE clause). There is no real-time sync — each browser tab works independently and collides only at save time.

Current session lifecycle:
1. Session started → `status: "running"`
2. Pause → `SessionPauseLog` entry created (`pausedAt`, no `resumedAt`) + `status: "paused"`
3. Resume → open `SessionPauseLog` gets `resumedAt` + `status: "running"`
4. Bill issued → inventory deducted, `Bill` record written, session closed

Known pain points driving this change:
- No correction path when pause timestamps are wrong
- No visual urgency for forgotten paused sessions  
- Inventory not reserved until bill → race condition across sessions sharing stock
- Version-conflict error drops user action silently
- LTP stations incorrectly default to "solo" for pool-table group play
- Zero-price bills can be finalized with no warning

## Goals / Non-Goals

**Goals:**
- Pause interval edit/delete from session details modal
- Red card + overtime animation for paused sessions
- Inventory reserved at item-add time, reconciled at bill finalization
- Version-conflict recovery: auto-reload + replay or one-click Retry
- LTP stations default playMode = "group"
- Hard block on bill issuance when total ≤ 0

**Non-Goals:**
- Real-time multi-tab sync (out of scope — the version-locking model stays)
- Inventory forecasting or low-stock alerts
- Automated session resumption after a timeout
- Changes to the Supabase schema (all changes stay within the `AppData` JSON blob)

## Decisions

### D1 — Pause interval editing: in-modal list with inline edit

**Decision**: Render each `SessionPauseLog` entry as an editable row inside the session details modal. Each row shows `pausedAt` and `resumedAt` (or "—" if still open) with an edit pencil and a delete icon. Editing opens a small datetime-picker inline. Saving writes directly to `appData.sessionPauseLogs`.

**Alternative considered**: Separate "Pause History" drawer/page. Rejected — adds navigation complexity; the modal is already the correct context.

**Constraint**: Editing cannot create overlapping intervals (validate before save). Deleting an open pause entry auto-sets `status: "running"` on the session.

### D2 — Pause visual indicators: CSS class + requestAnimationFrame timer

**Decision**: The `DashboardPanel` station card already uses `is-${session.status}` CSS classes. Add:
- `is-paused` → red border/background (already partially styled)
- A JS timer (via `useEffect` + `setInterval` or a custom hook) that computes elapsed pause ms from the open `SessionPauseLog`. After 600 000 ms (10 min) append class `is-paused-overtime` which triggers a CSS keyframe pulse animation.

**Alternative considered**: Server-side flag pushed via Supabase realtime. Rejected — adds infra complexity; a client-side timer is sufficient and matches the existing offline-first approach.

**No auto-resume**: The 10-minute limit is visual only. Removing the hard limit preserves operator flexibility.

### D3 — Inventory reservation: pessimistic decrement with compensating writes

**Decision**: When `addItemToSession()` is called, immediately decrement `item.stockQty` and write a `StockMovement` with `reason: "session_reservation"`. When the item is **removed** before billing, write a compensating `StockMovement` with `reason: "session_reservation_void"` that restores stock. At `finalizeCheckout`, change the movement reason from `"session_reservation"` to `"sale"` (no net quantity change — already decremented).

**Alternative considered**: A separate `reservedQty` field alongside `stockQty`. Rejected — two fields that must stay in sync add complexity and don't give cleaner UX than a single authoritative `stockQty`.

**Risk**: If a session is deleted or abandoned without checkout, reservations stay decremented. A periodic or manual "release orphaned reservations" step will be needed (tracked as a future task).

### D4 — Concurrent update handling: reload + show retry button

**Decision**: In `saveRemoteSnapshot`, after catching a version-conflict error:
1. Reload latest data (`refreshRemoteState`) — already done.
2. Store the failed action's callback in a `pendingRetryAction` ref.
3. Show a toast/banner: "Data updated by another device — [Retry]" where clicking Retry re-executes the callback against the freshly loaded state.

**Alternative considered**: Automatic silent retry. Rejected — the user's pending changes might no longer apply cleanly against new data (e.g., the item they tried to add is now out of stock). A user-visible retry is safer.

### D5 — LTP group default: one-line fix

**Decision**: In `App.tsx` line 687, change `station?.ltpEnabled ? "solo" : "group"` to always default `"group"`. The LTP solo/group choice is still shown in the UI; the default just changes.

**Rationale**: Pool table group sessions are the common case. Operators were incorrectly overriding "solo" every time.

### D6 — Zero-price bill guard: pre-finalization validation

**Decision**: In `finalizeCheckout()`, before any mutations, check `if (preview.total <= 0) throw new UserFacingError("Bill total is ₹0. Add items or remove discounts before issuing.")`. Surface this as a blocking modal, not a dismissable toast.

**Also**: Add a one-time audit query (run manually in Supabase console) to identify past zero-price bills — document the query in a comment in the source. No automated migration needed.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| D3: Orphaned reservations if session abandoned | Document a manual release flow; add a "Release reservation" button on session delete |
| D3: Double-decrement if an item was added before this change ships | On deploy, scan existing open sessions and skip re-reservation for pre-existing items (add `reserved: boolean` flag to `SessionItem`) |
| D4: Retry callback captures stale closure state | Callbacks must be written as pure functions of `appData` (already the pattern); document this constraint |
| D2: `setInterval` in many cards on large dashboards | Use a single top-level timer that derives per-card overtime status from a shared timestamp map |
| D1: User edits pause to before session start | Validate: `pausedAt >= session.startTime` and `resumedAt > pausedAt` |

## Migration Plan

All changes are additive within the `AppData` JSON blob stored in Supabase. No column changes needed. Deploy is a standard frontend build push. Rollback is re-deploying the previous build.

For D3 (inventory reservation): on first load after deploy, existing open sessions have `SessionItem` entries without a corresponding `session_reservation` stock movement. A one-time migration function (run on app startup once, guarded by a flag in `AppData.meta`) will reconcile these by writing reservation movements for all open-session items.

## Open Questions

- D3: Should inventory reservation be skipped for items with `stockQty = -1` (unlimited stock sentinel)? Likely yes — confirm with operator.
- D4: What is the maximum number of retries before we give up and ask the user to hard-refresh?
- D1: Should deleted pause entries be soft-deleted (kept with a `deleted` flag) for audit, or permanently removed?
