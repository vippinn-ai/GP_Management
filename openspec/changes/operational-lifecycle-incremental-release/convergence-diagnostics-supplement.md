# Fixed convergence diagnostic supplement

Preparation only. Independent approval and fresh immutable source/runtime/run identities are required before staging execution. Production is excluded.

`node scripts/run-operational-v2-staging-e2e.mjs --convergence-diagnostics --list` discovers exactly the existing 50 reload-versus-unrelated-mutation pairs case and executes zero tests. The invocation without `--list` retains all existing environment, source, runtime, actor, database proof/rollback, bundle, reservation and zero-retry guards. Arbitrary selectors remain forbidden. This is one complete existing test, not reduced iteration coverage.

Mode is `convergence-diagnostics`, suite is `operational-lifecycle-convergence-diagnostics`, expected count is 1 and `fullReleaseGate` is false. It cannot certify inventory2 or full31. All existing operation/HTTP/UI/7000ms outer limits remain unchanged. Failed or ambiguous results require preserved evidence and read-only reconciliation, never automatic retries.

Immediate posttest uses the existing generated read-only SQL and a separate strict verifier:

```text
node scripts/verify-convergence-diagnostics-posttest.mjs --manifest=<path> --manifest-sha256=<sha> --result=<path> --result-sha256=<sha> --browser-manifest=<path> --browser-manifest-sha256=<sha> --summary=<path> --summary-sha256=<sha> --expected-commit=<approved40> --expected-source-sha256=<approved64> --expected-runtime-sha256=<approved64>
```

Run from the candidate root so sealed relative evidence paths resolve correctly. Four exact hashed inputs, uniquely sealed summary, approved commit/source/runtime identities, exact test identity and zero retries are mandatory. Source/runtime hashes are recomputed. The verifier requires five clean operational floors, six empty live residual collections, zero same-target counts, unchanged exact five-field app_state and seven-function map, passed actor admission and identical before/after bundle evidence. It writes a new exclusive `convergence-diagnostics-posttest-verification.json`, never overwriting an existing receipt. Full31 and inventory verifiers remain unchanged.

Independent code review and independent offline testing precede any live run. A focused pass is diagnosis evidence only; separate full31 acceptance and explicit production approval remain required.

The verifier also reads the unique canonical `operational-v2-50-unrelated-reload-races.json` sealed under this run's output directory, verifies its hash, and requires all 50 complete ordered pairs, the 4/3/43 matrix, matching case/diagnostic targets, mutations and timings, strict sub-7000ms completion and all 12 uniquely named successful nonnegative phase spans. Missing, truncated, changed, duplicate or out-of-run diagnostic evidence is a failure, even if the compact test summary claims success. A successful receipt is labeled `convergence-diagnostics-passed`, never full-suite acceptance.
