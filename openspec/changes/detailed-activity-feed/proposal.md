# Detailed activity feed

## Problem

The dashboard currently renders only the first 20 in-memory audit messages. It does not show the staff member, has no server pagination or filters, and cannot prove complete coverage. Several operational RPCs also accept `user_id` from the client and some operational events have no matching audit row, so an expanded UI over `audit_logs` alone would overstate attribution and completeness.

## Outcome

- Admin, manager, and receptionist receive a read-only Activity tab.
- The dashboard uses the same source for a compact recent feed and a Show All action.
- Every committed business mutation produces an immutable, idempotent activity record with server time and authenticated actor.
- Historic audit/event data remains visible as explicitly labelled legacy evidence; missing detail is never invented.
- Activity reads are organization-scoped, cursor-paginated, filterable, realtime-aware, and do not expand application bootstrap.

## Scope

Committed session, customer-tab, billing, payment, inventory, configuration, expense, user-administration, and maintenance mutations are activity. Passive reads, navigation, typing, searches, receipt views, and prints are not activity in this release. Failed authentication and denied attempts remain platform-security telemetry and are not presented as committed business activity.

## Release gates

1. An exhaustive action/RPC coverage matrix is approved and contract-tested.
2. Additive schema, backfill, grants, actor canonicalization, read RPC, and rollback are verified in staging.
3. Local tests/build/lint and reusable staging Playwright tests pass.
4. A separate tester and a separate code/security auditor both issue GO for the same commit, SQL fingerprints, and staging Worker version.
5. Production requires a fresh backup, empty-floor preflight, rollback artifacts, and explicit approval.

## Non-goals

- No logging of page views, keystrokes, searches, or receipt printing.
- No edit/delete controls for activity records.
- No redesign of billing, pricing, stock, or session calculations.
- No production deployment in the implementation phase.
- No retroactive invention of actor, time, or details for legacy rows.
