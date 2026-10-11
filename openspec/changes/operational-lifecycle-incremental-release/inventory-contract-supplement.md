# Fixed inventory-contract supplemental gate

Preparation only; not live authorization. The default runner remains the full 31-case release gate.

`node scripts/run-operational-v2-staging-e2e.mjs --inventory-contract --list` discovers exactly two cases and executes zero tests. `--inventory-contract` is the corresponding gated live invocation; it accepts no arbitrary selectors, configuration, retries, project or reporter overrides. The fixed cases are the unit-sale continuation case and hop-versus-timing/pause/resume/add/remove mutation race. File, project and complete title must match the two immutable identities in `lifecycle-runner-guards.mjs`.

Both modes retain clean candidate/source, runtime inputs, staging environment, deployed bundle, installed SQL/ACL lineage, transactional database proof/restoration, actor preflight, unique run reservation, zero retries and complete-result checks. Mode is bound into runtime identity, run reservation and evidence manifest. Supplemental evidence is labeled `operational-lifecycle-inventory-contract`, `expectedTestCount: 2`, `fullReleaseGate: false`; it must never satisfy the full 31-case release gate. Switching mode requires a fresh runtime hash and unique run ID.

## Mandatory remaining pre-execution gate

The existing full-suite posttest verifier expects three same-target race rows. This supplemental pair expects zero such rows and must not use or weaken that verifier. The separate `scripts/verify-inventory-contract-posttest.mjs` binds the exact two-case browser manifest and complete zero-retry summary: zero same-target counts, all five operational floors and six residual collections empty, original five-field app_state and seven installed function definition identities preserved. Existing runner SQL/security gates remain mandatory. Independent review of this focused contract is required before live execution; implementation alone does not authorize a run.

After the immediate read-only posttest capture, run the focused verifier with exactly four paths and their approved SHA-256 values:

```text
node scripts/verify-inventory-contract-posttest.mjs --manifest=<posttest-manifest> --manifest-sha256=<sha> --result=<raw-result> --result-sha256=<sha> --browser-manifest=<focused-evidence-manifest> --browser-manifest-sha256=<sha> --summary=<compact-summary> --summary-sha256=<sha>
```

It creates `inventory-contract-posttest-verification.json` beside the posttest manifest exclusively, refusing overwrite. Exact-ID cleanup if necessary, immutable evidence and zero-retry stop conditions remain mandatory. A failed, ambiguous or incomplete run cannot be promoted to acceptance by a clean floor alone.

## Hop-mutation timing and item-identity repair

The stopped `normops-20261010-0215-inventory-be2388f` run is historical failure evidence, not acceptance. Its unit-sale case passed; the hop-mutation case submitted its hop and received HTTP 400 after the test's edited minute-rounded end preceded the newly started session, but the old assertion order did not preserve that response body. The successor harness remains test-only: it first acknowledges a `-15` minute source start, captures the competing command before preparing the hop, then preserves the checkout state's unedited full-precision end rather than truncating it through the minute-only input. Before either held request is submitted, that captured end must be at or after canonical start, existing pause/resume and captured competing instants and no later than the capture check. The two held requests still submit once through the same `Promise.all`; no RPC is held across a clock-boundary wait.

Before outcome assertions, the harness persists sanitized command, status, allowlisted rejection-code and timing evidence for both responses (or sanitized transport-failure evidence). Add/remove outcomes are keyed by the captured session-item ID and exact before/after ID-set delta; display names are not identity. Existing full bill-line inventory/variant/pack/quantity/price parity remains mandatory. These local changes do not claim a new staging pass or modify application/SQL runtime behavior; a fresh clean source identity, review and separately guarded live execution remain required.

No runtime/SQL behavior changes are part of this runner supplement. Passing two cases is targeted regression evidence only; full release acceptance still requires the unchanged 31-case workflow.
