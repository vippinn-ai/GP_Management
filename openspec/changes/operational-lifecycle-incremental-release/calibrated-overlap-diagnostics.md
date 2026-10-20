# Failure-preserving calibrated overlap diagnostic

Test-only successor to the October20 full31 failure. No application, SQL, business rule, retry or performance-budget changes.

## Capture

The existing ten calibrated pairs retain their operations and order: concurrent creates, concurrent reject requests, sequential creates, sequential reject requests. The existing eight-minute case timeout, less-than100ms submission skew and p95 wall ratio less-than0.85 remain unchanged. No sleeps, retries or weaker limits are introduced.

A test-only capture records the current iteration/stage and complete samples. The budget is recorded before its assertion; the artifact is emitted in `finally` through the existing failure-preserving cleanup. An earlier failure yields incomplete evidence, never a fabricated completed sample. Evidence-attachment failure does not replace a primary assertion failure and fails an otherwise successful test. The projection excludes request payloads, raw response bodies, headers and error text; it retains only client/RPC/mutation identity, timestamps, elapsed time/status and optional finite nonnegative server duration. Reported server duration does not prove total transaction or network time.

## Fixed selection and acceptance

### Additive phase checkpoints (21 October)

Every direct RPC records diagnostic-only `requestPostAwaitMs` (through Playwright's buffered-response return), `bodyReadAndParseMs` (buffered body retrieval and parsing), and `phaseOutcome`. The original total elapsed and both pair wall timers remain unchanged gate inputs. These phases are not headers/TTFB or isolated network time. Server duration still excludes later SQL work and commit. Failure emits one sanitized partial record with null unavailable phases and null status, rethrowing the original error; successful malformed-JSON fallback stays unchanged. No raw error, request or response content is added to failure records. The calibrated projection remains allowlisted.

The success verifier requires complete finite nonnegative phases whose sum does not exceed rounded total elapsed (0.011ms rounding allowance); missing or failed phases cannot pass. This is additional evidence validation, not a replacement performance metric. Local tests must pin unchanged numerator/denominator, sample order/count, thresholds, zero retries, error identity, zero duration validity, and secret-free partial evidence.

`node scripts/run-operational-v2-staging-e2e.mjs --calibrated-overlap-diagnostics --list` must discover exactly the existing calibrated-overlap case without executing it. Omit only `--list` to execute that exact case after admission. Mode `calibrated-overlap-diagnostics`, expected1 and `fullReleaseGate:false` cannot grant full31 acceptance. Arbitrary selectors and overrides remain forbidden. Default31, inventory2 and convergence1 remain unchanged.

The dedicated `verify-calibrated-overlap-posttest.mjs` accepts exact SHA-bound manifest/result/browser-manifest/summary inputs plus expected commit/source/runtime hashes (same argument naming as the convergence verifier). It requires exactly10 completed samples,80 sanitized HTTP200 RPC records with exact run-owned identities, matching concurrent skew, sequential ordering, recomputed ratios and passing unchanged p95. It also requires the canonical timing artifact uniquely sealed beneath this run's output directory. Missing/partial/failed evidence cannot pass.

Read-only posttest must establish the exact five zero global floors, six zero live-residual groups, five zero same-target counters, unchanged app_state and seven function hashes, and zero bills/payments/financial mutations. A new exclusive verification receipt grants diagnostic-only acceptance. Any failed run still requires safety reconciliation and must retain its failed sealed status.

## Gates

Independent review and offline helper/runner/verifier tests precede staging. Freeze the exact source, preserve original failed evidence, bind a fresh source-specific admission/proof and run identity, verify actual staging deployment/bundle, use approved distinct actors and zero retries, reconcile afterward, deactivate owned accounts and restore the baseline. Production is excluded. Do not relabel a previous proof as a new source execution.
