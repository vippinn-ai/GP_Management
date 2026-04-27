## Context

Currently a session's `closeDisposition` can be `"billed"` (checkout issued a bill) or `"rejected"` (session written off). There is no concept of closing a session without billing while keeping its charge data available for future billing. Each session links to exactly one bill via `session.closedBillId`. The `startSession` function currently blocks a new session if the customer has pending bills (`getPendingBillsForCustomer`), but hopped sessions produce NO bill so they don't trigger this check.

The `CheckoutState` type tracks which session is being checked out. A combined bill requires extending this to also reference additional sessions whose charges should be bundled into the same bill.

`getSessionCheckoutLines(session, chargeSummary)` already generates line items for a single session (session charge + session items). For a combined bill, we call this function for each hopped session using `session.endedAt` as the effective end time (already set when the session was hopped).

## Goals / Non-Goals

**Goals:**
- Staff can close a session as "hopped" — station released, no bill, customer details preserved.
- Start-session form pre-fills customer from most recent hopped session.
- At checkout, hopped sessions matching the customer are surfaced for optional inclusion.
- A single bill can contain lines from multiple sessions.
- After combined billing, each hopped session is marked "billed" with `closedBillId`.

**Non-Goals:**
- Merging customer tabs across hops (tabs remain independent).
- Auto-combining without staff confirmation.
- Allowing a customer to have an unbilled "hop" across multiple days (no cross-day hop support in v1).
- LTP win discount on hopped sessions (LTP is only supported in the current/live session checkout).

## Decisions

### Decision 1: Store `closeDisposition = "hopped"` as the signal

Hop sessions are identified by `closeDisposition === "hopped"` on the session record. No new table or join is needed — the existing session record preserves all charge data (`pricingSnapshot`, `items`, `startedAt`, `endedAt`).

Alternative: a separate `hoppedSessions` table. Rejected — unnecessary complexity; sessions already carry all needed data.

### Decision 2: "Game Hop" triggered inside the existing checkout modal

A new radio/button option "Close for game hop — bill later" appears in the checkout modal. When selected, the payment/amount fields are hidden and a "Confirm Hop" button replaces "Issue Bill".

Alternative: a separate button on the session card bypassing the modal. Rejected — the checkout modal already validates session timing and is the right place for a close action.

### Decision 3: Combined bill via `hoppedSessionIds` field in CheckoutState

`CheckoutState` for `mode === "session"` gets an optional `hoppedSessionIds?: string[]`. When set, `getSessionCheckoutLines` is called for each hopped session (using its stored `endedAt`) and for the current session, and all lines are concatenated before preview and billing.

Alternative: a new `mode === "combined_session"`. Rejected — combined billing is an extension of the normal session checkout, not a different mode. Keeping it in `mode === "session"` means the rest of the checkout flow (payment, discounts, customer details) is unchanged.

### Decision 4: Customer matching by phone (primary) then name (fallback), shown to staff for confirmation

When the checkout modal opens, the system searches `appData.sessions` for sessions where:
- `closeDisposition === "hopped"` AND `closedBillId` is undefined (not yet billed)
- `customerPhone === currentCustomerPhone` (if phone is present) OR `customerName.toLowerCase() === currentCustomerName.toLowerCase()` (fallback)

These are displayed as a checkbox list in the checkout modal. Staff confirms which ones to include. No auto-include — staff always decides.

### Decision 5: After combined billing, update each hopped session

Inside `mutateAppData` in `finalizeCheckout`, for each `hoppedSessionId`:
- Set `targetSession.closedBillId = billId`
- Set `targetSession.closeDisposition = "billed"`
- Add audit log: "Included in combined bill `${billNumber}` for `${station.name}`"

### Decision 6: Customer auto-fill in start-session form

After a hop, when staff opens the start-session dialog, the form queries:
```
mostRecentHop = sessions
  .filter(s => s.closeDisposition === "hopped" && !s.closedBillId)
  .sort by endedAt desc
  [0]
```
If found, pre-fill `customerName`, `customerPhone`, `customerId` in `startSessionDraft`. Staff can still override. This reduces re-entry friction.

## Risks / Trade-offs

- [Risk: Unbilled hopped sessions accumulate if staff forgets to bill] → Mitigation: show a count of unbilled hopped sessions in the dashboard or session list as a visible reminder. Out of scope for v1 but noted.
- [Risk: Name-only matching causes wrong sessions to be suggested] → Mitigation: staff always manually confirms; suggestion is never auto-applied.
- [Risk: A hopped session's charge could change if pricingSnapshot changes] → Not a risk; `pricingSnapshot` is stored on the session at creation time and is immutable.
- [Risk: `endedAt` on hopped session is the hop time, not the "actual play end"]. → Staff controls the hop time via the checkout modal's session timing editor (existing feature). No new risk.

## Migration Plan

No data migration. `closeDisposition = "hopped"` is additive. Existing sessions with `"billed"` or `"rejected"` are unaffected. `storage.ts` normalization should default `closeDisposition` to its existing value (no change needed). Frontend-only deploy.
