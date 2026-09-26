# Incremental lifecycle release

## Why

Deliver the original hop/reject latency and pending-sync improvements independently of startup optimization. The owner directed this split on 25 September 2026. This package extracts the lifecycle unit from operational-performance-decoupling; it does not relabel any old failed performance run as passed.

## Verified frontend baseline

Base: c0e0d2133f39372aac43e669c05e8c27ad5a255c. A fresh isolated local Vite build using the existing production build configuration, Activity enabled and no operational-v2 assignment reproduced the public production entry index-BATQAFhe.js byte-for-byte: 1,542,399 bytes, SHA256 fd772bd187f5ceb914db8981cdd0f50e76b6298953d1d513748b8701e78e65a5. Public readback was captured 26 September at 09:41 UTC. This is frontend entry provenance, not verification of installed SQL or all runtime behavior.

The live frontend's normalized bootstrap/live-read/realtime/operational-write prerequisites are enabled, alongside Activity and financial v2. Preserve them.

## What changes

- Add default-off lifecycle-v2 routing for hopSession, rejectSession and rejectCustomerTab.
- Retain normalized-only SQL and the required start/open-tab/link continuation locking and actor corrections.
- Confirm canonical hydration before acknowledgement; preserve manual same-ID recovery and continuation semantics.
- Carry necessary realtime readiness, ordered catch-up, bounded dedupe, tenant/generation guards and read-only error handling.
- Fail closed on catch-up overflow, share overlapping snapshot loads, and pause undispatched queued operations when readiness is lost.

## Exclusions

No atomic bootstrap RPC, parallel entry, deferred history, panel lazy loading, export splitting, clock/render changes, new Activity feature, billing/pricing redesign, or admin mutation redesign. No automatic push/deployment. Production requires immediate owner approval after independent tester and reviewer acceptance.

## Success

Focused lifecycle correctness, measurable operation latency, no unintended financial/stock effects, reload/realtime convergence and compatible rollback. The global 30-cold-load/40-percent startup target belongs to a separate release. See test-plan.md for retained operation gates and evidence boundaries.
