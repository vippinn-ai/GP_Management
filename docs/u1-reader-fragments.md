# U1 verification-reader fragment correction

## Evidence and scope

The 15 November recovery baseline completed one session start but no measured
pair. Its execution and safety-postflight reads returned the first fragment,
then failed with `U1_READ_SQL_TIMEOUT`. Independent full postflight reconciliation
confirmed the exact start effects; cleanup and QA retirement passed. This is not
evidence of an application-write regression or proof that Activity alone caused
the timeout.

The correction changes the test reader only. Application candidate and baseline,
business rules, RPCs, schema, grants, feature flags and production remain unchanged.

## Contract

Use four strict fragments: app-state/floor (plus existing admission metadata),
Activity, the other 16 tables of the former first group, and the unchanged final
16-table group. Preserve every per-table SQL expression, ownership predicate,
unowned count/hash/order, all 33 protected tables, repeatable-read transaction,
physical staging guard and rollback. Protected, preflight and authority consumers
must use the same format. Historical three-fragment artifacts retain their old
source/decoder; do not rewrite them or accept them as new-format evidence.

All existing limits remain: 5-second SQL statement, 1-second lock, 15-second read
process, 32 MiB capture, 50 pairs, 250 phases, zero retries and existing UI budgets.
Fragmentation must not omit data or introduce sample replacement or warmups.

## Verification gates

- Prove exact per-table expression and complete-envelope equivalence locally.
- Exercise all three consumers and reject old/partial/duplicate/reordered/mixed
  snapshots, wrong tables, invalid fingerprints, malformed UTF-8 and oversize data.
- Retain diagnostic failure codes and timeout behavior.
- Independently review source and execute local integration tests before any
  new staging read. A local pass is not database reliability or UI speed evidence.
- A future staging read/campaign needs fresh environment/data/actor authority,
  independent admission and immutable evidence under the existing contract.

This document records intended controls, not a passing staging result.
