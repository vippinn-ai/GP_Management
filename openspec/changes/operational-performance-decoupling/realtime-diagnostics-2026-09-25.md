# Realtime failure diagnostics (25 September 2026)

## Scope and evidence qualification

Candidate-k stopped on a realtime readiness timeout before all 30 loads completed. Its failed evidence is preserved; staging was restored and the scale fixture cleaned. The cause of the timeout is **not established**. This change improves the reusable test harness and characterizes existing gateway behavior; it does not fix or change product runtime, SQL, timeout budgets, retries, or acceptance thresholds.

## Contract

- Persist each completed sample's measurement immediately, not only in the final aggregate. On success or failure, capture diagnostics before context teardown, then write a separate terminal record. Use exclusive creation; never replace evidence from a consumed run.
- Record only fixed endpoint/error categories, relative times, HTTP status, WebSocket creation/close/error, frame direction and byte length, connection sequence, and explicitly allowlisted performance marks. A created socket is not proof of connection acknowledgement. Never retain URL queries, payloads, response bodies, tokens, headers, console text, exception messages/stacks, or customer values in these new diagnostics.
- Bound transport events to 512, marks to 128, and each JSON artifact to 1 MB. Retain overflow/invalid counts. Missing, invalid or truncated diagnostics cannot support a passing run. Preserve the primary assertion failure even if capture, evidence writes or teardown also fail.
- Bound page mark capture to 1 second, overall capture to 2 seconds and context close to 5 seconds. Close each created sample context once, even when navigation or assertions fail. No retry/replay loop is added.
- Handle every asynchronous response collector rejection; retain only fixed endpoint, failure-stage and error categories. Bound outstanding collector settlement to 750 ms, in parallel with mark capture. Pending or failed collectors make diagnostics incomplete. Terminal records distinguish capture, persist and validate failures from body/close failures. If the terminal write itself fails, preserve any original primary error unchanged; otherwise throw a sanitized `terminal-write` lifecycle error. The manifest explicitly lists missing terminal files and cannot accept a successful run with missing or duplicate sample evidence.
- Synchronously seal collector admission and detach the named response collector before parallel mark capture and settlement. Take the collector result again after both complete; any attempted late admission invalidates evidence. The lightweight transport observer remains active until its final snapshot. This closes the evidence race found in rejected local commit `cbf6f81`; that commit was never pushed or deployed.
- Preserve the 30-sample, one-worker, zero-retry performance contract. The runner's immutable evidence manifest includes the per-load files. Include the diagnostic helper in the exact harness identity; a fresh same-harness baseline/candidate pair is mandatory. Old baseline-k cannot be reused.
- Preserve the runtime 10-second watchdog, subscription-before-bootstrap order, cached failure and explicit-manual-reset-only recovery.

## Executable local acceptance

1. Failure on load 1 and load N retains earlier measurements, the failing load's diagnostics and terminal record, and prevents load N+1.
2. Test privacy using secret-bearing URLs, console/errors, string/binary frames and mark detail. Only safe categories, byte sizes and allowlisted numeric marks survive.
3. Test invalid/non-finite timings, overflow, browser capture timeout, duplicate artifact path, oversized artifact, capture/write/teardown/terminal failures and primary-error precedence.
4. Mutating the diagnostic helper changes the default harness hash and rejects an old baseline.
5. Gateway fake timers prove 9,999 ms pending, 10,000 ms failure, both same-boundary callback orderings, just-before-timeout success, explicit provider terminal statuses, ignored late callbacks, cached failure across prepare/load/remount, and exactly one fresh channel/RPC after explicit reset.
6. Run focused and full unit suites, TypeScript, lint, build, selected Playwright static checks, one-test discovery and strict OpenSpec validation. Independent code and test review must assess the exact candidate before a new live staging run.

The reusable `test:e2e:staging:operational-v2:static` gate includes the performance spec and diagnostic helper. The runner's extracted evidence-file collector is exercised against real temporary partial-run files (failure on sample 1/N), verifying every retained file's exact SHA-256 and length. Both helper modules are included in the harness identity.

## Remaining release gates

Local harness approval is not performance acceptance or a production GO. Next live evidence needs fresh time-valid fixture/bootstrap/profile lineage, a baseline and candidate on the same harness, unchanged gates, postflight and cleanup. Functional/concurrency suites and independent release sign-offs remain required. No production action is authorized by this diagnostic change.
