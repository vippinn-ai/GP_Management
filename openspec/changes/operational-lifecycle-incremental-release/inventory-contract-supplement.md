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

No runtime/SQL behavior changes are part of this runner supplement. Passing two cases is targeted regression evidence only; full release acceptance still requires the unchanged 31-case workflow.
