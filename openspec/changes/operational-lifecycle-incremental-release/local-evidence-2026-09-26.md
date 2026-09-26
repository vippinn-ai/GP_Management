# Local extraction evidence, 26 September 2026

This is a local draft checkpoint, not independent release acceptance or a deployment receipt.

## Baseline and exclusions

Clean c0e0d2133f39372aac43e669c05e8c27ad5a255c build matched the public production entry exactly; see proposal.md. Git diff confirmed no edits to main entry, backend authentication, panels, components, billing, pricing or the financial RPC client. Root WIP and the mixed performance branch remain untouched.

## Executed checks

- TypeScript project build: passed.
- Full serial Vitest: 62 files, 594 tests passed, zero failed. Report test-artifacts/r1-full-suite-20260926.json; SHA256 926385eb78a4fe0084f76c089119d91e765c243f7fa8e3c70b1f96366190504f.
- Configured source lint scope: zero errors, four existing warnings in NumericInput, SellableInventoryPicker, BillRegisterPanel and InventoryPanel. Report test-artifacts/r1-source-lint-20260926.json; SHA256 d9d0a48d97fa86753f7834875da23f57afc7eb6f79405a63213538bebf35aff1.
- Staging-target local builds with lifecycle v2 ON and OFF: passed, existing large-chunk warning retained. No upload or deployment.
  - ON entry index-CRmZEn-8.js: feb7294dcbd7765e82c7722d82d3a42609eab3e75517bf159c965ac595026c39.
  - OFF entry index-C_UxgEQE.js: d772c277b4279dbc23de263d0338694e5bdcc459cb9dfa3dd42597400ee27f5e.
- Branch-scoped atlas extraction: 348 files, 14,762 nodes, 38,939 edges; source fingerprint 3f3d29c782e9e8c3538024a9279935cf0a2dafd2861e1012001fc7025324daca. Static relationships are not runtime coverage.
- Git diff whitespace check passed.

## Preserved unsuccessful preparation

An initial build attempt referenced an absent temporary env file and stopped before building. The successful baseline build used the existing root production build configuration in process memory only; no credentials were copied or printed.

Initial test commands encountered an unsupported minWorkers CLI option and the known Windows sandbox config-read restriction; neither ran tests. Focused extraction found an expected flag-object assertion mismatch, compatibility-mode full-refresh regression and absent staging-tooling files referenced by the imported combined SQL suite. Corrected the flag assertion, retained compatibility-mode refresh while keeping normalized mode fail-closed, and separated pure runtime SQL assertions from staging-tooling tests. Staging tooling remains a separate pending port/verification gate, not deleted coverage.

The first new queue test had an invalid second audit fixture (inner entity ID differed from envelope). Its failed 80/81 report remains test-artifacts/r1-focused-20260926.json. Corrected App-only 2/2 report remains test-artifacts/r1-queue-corrected-20260926.json; the subsequent complete suite passed unchanged application validation.

An overbroad eslint-dot invocation traversed generated bundles and historical E2E files and failed; it is not the project's configured source lint scope. The reported zero-error result is specifically the source gate, not a claim that all historical E2E tooling passed lint.

## Independent findings addressed locally

The first read-only draft review was NO-GO for overlapping snapshot reads and dispatch after disconnect. Added generation-bound single-flight restore, immediate readiness invalidation, per-dispatch recheck and pending preservation. New tests cover overlapping reads, 1,001-event overflow before/during catch-up, pending teardown, serial/deduped hydration, stale callbacks across account/remount changes and disconnect-mid-queue. Re-review remains distinct from passing local tests.

## Remaining

The independent reviewer subsequently confirmed both concrete extraction blockers closed and found no remaining source blocker in the repaired paths. This permits continuation of the local candidate gate only; it does not approve broader SQL/security, staging or production release.

Independent final candidate review/test; staging harness extraction and source binding; read-only installed production SQL baseline; guarded staging correctness/performance/rollback and cleanup; explicit production approval. No staging or production writes occurred during this local checkpoint.
