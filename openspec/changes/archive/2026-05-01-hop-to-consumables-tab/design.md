## Context

The current game-hop flow closes a gaming session with `closeDisposition = "hopped"`, preserves its charge data, and immediately opens a "Start Next Game" modal. The combined billing implementation already supports including unbilled hopped sessions when checking out another gaming session.

The app also has an existing `CustomerTab` model for consumables-only tracking. Customer tabs are not a separate gaming session, but they are the existing workflow for customers who stay back for food, drinks, sheesha, or other products after gameplay. Today, customer-tab checkout does not include unbilled hopped game sessions.

## Goals / Non-Goals

**Goals:**
- Keep the post-hop default as starting another gaming session.
- Add a consumables continuation option to the same post-hop modal.
- Reuse the existing customer-tab workflow for consumables continuation.
- Prefill the consumables continuation with the hopped customer's details.
- At customer-tab checkout, show matching unbilled hopped game sessions preselected for inclusion.
- Let staff uncheck previous hopped sessions; unchecked sessions remain unbilled/hopped for later.
- Preserve the existing receipt line labels and discount behavior.

**Non-Goals:**
- Do not create a new consumables-only session data model.
- Do not create a separate post-hop screen.
- Do not change receipt labels for carried-forward lines.
- Do not auto-waive or auto-discount previous sessions when staff excludes them.
- Do not change existing gaming-hop behavior except where needed to add the continuation choice.

## Decisions

### Decision 1: Reuse `CustomerTab` for consumables continuation

The consumables continuation will call the existing open/find customer tab path with the hopped customer's details, then route staff to the Sale panel. This avoids a new data model and keeps consumables behavior consistent with the rest of the app.

Alternative: create a new zero-game `Session` mode. Rejected because the user explicitly selected the existing customer-tab option.

### Decision 2: Add a post-hop continuation mode in the existing modal

The `lastHoppedSessionId` modal will support a small mode selector with `"gaming"` as the default and `"consumables"` as the alternate path. Gaming mode renders the existing station/session fields. Consumables mode renders the customer fields and a start/open tab action.

Alternative: create a separate consumables modal. Rejected because the desired experience is one window.

### Decision 3: Extend combined billing to customer-tab checkout

`CheckoutState.hoppedSessionIds` already models selected prior game sessions. Customer-tab checkout will populate the same field by matching the tab customer against unbilled hopped sessions. Checkout line construction will prepend selected hopped session lines before the tab's consumable lines.

Alternative: attach hopped session IDs to `CustomerTab`. Rejected because selection is a checkout decision, and unchecked sessions must remain available for a later bill.

### Decision 4: Exclusion means "bill later"; discount means "include and discount"

If staff unchecks a previous hopped session, it remains `closeDisposition = "hopped"` and has no `closedBillId`. If staff wants to waive a previous session, they include it and use the existing discount mechanism with required discount reason.

Alternative: add an exclusion reason prompt. Rejected for v1 because existing state already tracks unbilled sessions, and discounts already have required reasons.

## Risks / Trade-offs

- [Risk: staff unchecks a previous session and forgets to bill it later] -> Mitigation: preserve it as an unbilled hopped session so it continues to appear in future matching checkout suggestions.
- [Risk: customer-tab inventory reservation differs from session reservation] -> Mitigation: verify customer-tab reserved quantity participates in availability checks before completing the change; fix only if the current code path does not freeze stock as intended.
- [Risk: remote concurrent checkout can stale a selected hopped session] -> Mitigation: reuse the existing remote validation that removes or blocks hopped sessions already billed elsewhere.

## Migration Plan

No data migration is required. This is an additive frontend behavior using existing `Session.closeDisposition`, `CheckoutState.hoppedSessionIds`, and `CustomerTab` records.
