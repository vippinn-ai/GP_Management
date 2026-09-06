# Tasks

## Baseline and specification

- [x] Inventory current dashboard, tabs, audit readers, mutation RPCs, actor sources, RLS, and realtime behavior.
- [x] Define committed-business-action scope and legacy-data treatment.
- [x] Create proposal, design, coverage, test, and audit contracts.

## Database

- [x] Add append-only activity schema, indexes, triggers, grants, and backfill.
- [x] Add authenticated cursor-paginated filter RPC.
- [x] Add read-only verification, rollback, and SQL contract tests.
- [ ] Prove authenticated actor/time canonicalization and spoof resistance.
- [ ] Prove every mapped mutation has audit or operational fallback coverage.

## Frontend

- [x] Add default Activity navigation for all roles and feature flag.
- [x] Add typed activity reader, cursor and filter model.
- [x] Build Activity panel, details disclosure, loading/error/empty states, and Load More.
- [x] Replace dashboard audit slice with compact activity feed and Show All navigation.
- [x] Add realtime invalidation/deduplication and local-browser fallback.

## Verification and rollout

- [x] Pass focused unit/contract/component tests (19/19).
- [x] Pass complete existing test suite (567/567), TypeScript build, and lint without new warnings (four pre-existing warnings remain).
- [x] Install additive SQL and deploy flag-enabled frontend to staging only.
- [ ] Run reusable zero-retry Playwright role/filter/realtime/action coverage.
- [ ] Obtain independent tester GO for the pinned commit and staging fingerprints.
- [ ] Obtain independent code/security auditor GO for the same identity.
- [ ] Prepare production backup/preflight/rollback package and request explicit production approval.

## Evidence

Every staging task records commit SHA, SQL artifact hash, deployed function/trigger hashes, Worker version, bundle hash, run ID, fixture IDs, cleanup result, and final reconciliation.
