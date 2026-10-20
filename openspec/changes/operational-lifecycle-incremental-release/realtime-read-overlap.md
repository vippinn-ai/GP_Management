# Bounded realtime read overlap — 20 October 2026

## Scope and decision

Independent reviewer and tester approved local implementation of independent
top-level read overlap. Staging and release approval require the exact resulting
candidate and executed checks. No production operation is authorized.

Only `loadNormalizedRealtimeOverlay` scheduling changes. Start its existing
optional broad, changed-live and bill groups plus existing customer, stock and
audit readers together. Preserve request parameters, selected rows and internal
parent-to-child dependencies. Full-refresh returns before starting any group.

Await `Promise.allSettled` for these logical groups. Reject in fixed priority:
broad, changed-live, bills, customers, stock, audit. On success assemble in the
original merge precedence and refreshed-slice order, returning once. No partial
publication. Event serialization, dedupe, organization/generation guards and
bootstrap buffering are unchanged.

## Error boundary

This drains logical reader promises, not transports. Existing internal
`Promise.all` and timeout races may leave underlying requests active. Existing
per-read 15-second limits remain; composed live/bill groups can take two waves,
and mixed broad reads can take approximately five waves. Waiting for all logical
groups can delay surfacing an error compared with the previous sequential path.
No new outer deadline, cancellation, retry or polling is introduced.

## Test contract

- Deferred-promise tests prove independent start overlap, reverse completion,
  exact merge/slice order and missing-customer handling.
- Every group failure and multiple reverse-order failures preserve fixed error
  priority. An early rejection waits for remaining logical groups.
- Full refresh starts no reads; empty IDs retain existing reader behavior.
- Real-reader tests preserve parent-before-child queries and existing timeout.
- Gateway regressions retain no publication on failure, serial same-entity
  events, duplicates, organization changes, disposal and bootstrap catch-up.
- TypeScript, lint, unit regression and both flag-mode builds remain required.
- Staging retains 50 pairs, strict <7000ms, zero retries and existing readiness,
  RPC and browser limits, then the full 31-case acceptance suite and final
  independent reviews. Immutable evidence, fresh preflight, QA cleanup,
  postflight and baseline restoration remain mandatory.

The change addresses a source-confirmed read waterfall. No numerical improvement
is established until measured. It does not explain the earlier slow direct RPC;
reported SQL duration excluded final writes and cannot isolate network time.
