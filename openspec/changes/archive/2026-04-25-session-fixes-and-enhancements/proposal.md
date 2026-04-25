## Why

Six operational issues have surfaced through daily use of the gaming session management system — ranging from critical revenue loss (zero-price bills being issued) to UX friction (no visual alert for forgotten paused sessions). These need to be fixed together because they all relate to the session lifecycle and billing pipeline.

## What Changes

- **Pause interval editor**: Add ability to edit or delete individual pause/resume timestamps on a session from the session details modal. The existing "edit start time" mechanism is extended to cover pause log entries.
- **Pause visual indicators**: Session cards turn red when paused; after 10 minutes of continuous pause the card enters an animated pulsing state as a visual alert. The 10-minute hard limit (auto-resume/force) is **removed** — only the visual warning remains.
- **Inventory reservation at item-add time**: Fix the bug where inventory stock is only deducted at bill issuance. Stock will be reserved (decremented) when items are added to a session or customer tab, and released if items are removed.
- **Concurrent update UX improvement**: The "Remote data changed in another browser" error currently blocks all actions. Add auto-retry logic so that after the latest data reloads, the triggering action is replayed automatically (or a clear "Retry" button is provided), rather than dropping the user's intent.
- **LTP pool table Group default**: When starting a session on an LTP-enabled station, default `playMode` to `"group"` instead of `"solo"`.
- **Zero-price bill guard**: Block bill issuance when the computed total is ≤ 0. Show a clear error. Also surface a root-cause audit log to identify how past zero-price bills occurred.

## Capabilities

### New Capabilities
- `pause-interval-editing`: View, edit, and delete individual pause/resume log entries from the session details modal
- `pause-visual-indicators`: Session card turns red when paused; animated pulse after 10 minutes of continuous pause
- `inventory-reservation`: Inventory stock is reserved when items are added to a session/tab and released on removal, with final settlement at bill issuance
- `concurrent-update-handling`: Auto-retry or one-click retry after a version-conflict error so the user's in-progress action is not silently lost
- `ltp-group-default`: LTP-enabled stations default playMode to "group" at session start
- `zero-price-bill-guard`: Validation that prevents bill issuance when total ≤ 0, with clear user feedback

### Modified Capabilities
- (none — no existing spec-level requirements are changing)

## Impact

- **`src/App.tsx`**: Pause editing handlers, inventory reservation on `addItemToSession`, LTP default fix, zero-price guard in `finalizeCheckout`, retry logic in `saveRemoteSnapshot`
- **`src/backend.ts`**: Potentially expose retry helper around the version-conflict path
- **`src/panels/DashboardPanel.tsx`**: Pause card color and animation logic
- **`src/styles.css`**: New CSS classes for `is-paused-red`, `is-paused-overtime` animation
- **`src/types.ts`**: Possibly a new `reservedQty` field on inventory items or stock movement reason types
- **`src/utils.ts`**: Zero-price bill check in `buildBillPreview` or caller
- **No schema/DB migrations required** — changes are within the existing AppData shape or additive only
