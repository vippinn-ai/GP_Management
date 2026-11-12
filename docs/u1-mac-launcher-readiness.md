# U1 Mac launcher readiness — 13 November 2026

Scope: portability of the supervised U1 harness, not a new application change.
Application candidate remains `70ee5ab00bd758c3de2b86e4f68ae76e69c82f1e`.
The clean Mac branch starts at harness `afe7c09017eb2450995ff2fd8197af9a1c9236de`.
No production action or live campaign is approved by this document.

## Implementation

- Windows core-v1 remains strict. Darwin requires explicit core-v2 platform and
  owned-process-group termination fields, with truthful tool roles.
- Darwin dependencies are worktree-local and installed from the unchanged lock.
- Discovery is browser-free. Execution owns Chrome BrowserServer and the test
  runner separately; both share the existing 20-minute and 32MiB budgets.
- A narrowly guarded parent spawn interception captures the pinned Chrome handle
  before startup completes. Unsettled startup cannot release the interception
  guard and silently create an untracked process later. Uncertain cleanup fails
  closed and requires manual closeout; it never permits another campaign.
- The browser endpoint stays in memory/child environment and is loopback-only.
- One worker, zero retries, original SQL/time/output/phase limits remain.
- Two scoped CRLF attributes preserve historical byte pins for rpcClient and
  normalizedReads; their normalized Git contents are unchanged.
- One obsolete authority-preflight command-plan pin is corrected to the already
  reviewed final module hash. No oracle or application logic was rewritten.

## Executed local evidence

- Application: 63 test files / 602 tests passed; build passed; lint zero errors,
  four existing warnings. This is local evidence, not a measured staging gain.
- Independent final portability suite: 13 passed, zero failed, one Windows-only
  test skipped on Mac. Real Chrome normal/failure/output-overflow cleanup passed
  while an unrelated Chrome survived. Timeout behavior used a controlled test
  scheduler, not a real 20-minute delay. Late-start and repeated-error cases pass.
- Authority-preflight and command-plan: main and independent 8/8 passed.
- Runtime negative/admission checks: main 5/5 passed. Unchanged historical
  250-phase synthetic evidence was not relabeled as a fresh execution.
- Code reviewer approves freeze and staging-package preparation. Tester approves
  local Mac evidence. Neither approval admits a live staging campaign.
- Staging-only identity diagnostic separately passed strict TLS/authentication
  using an explicit staging credential. No production credential was used.

## Remaining gates

1. Verify actual staging provider Git settings; obtain exact-commit push approval.
2. Capture current staging baseline/assets/config and verify rollback access.
3. Prepare fresh run-scoped preflight, identities, actors and immutable package;
   obtain both independent approvals on that exact package.
4. Execute the retained U1 campaign once, reconcile data, clean only owned
   fixtures, retire temporary roles and restore/verify the staging baseline.
5. Close remaining mapped U1 risks and measure actual baseline/candidate benefit.
6. Prepare deployment/backup/rollback evidence and seek explicit production
   approval. No production deployment is implied by a local or staging pass.

Keep earlier failed evidence: initial Mac integration could not contain detached
Chrome, clean LF checkout failed historical byte guards, and an obsolete pin
blocked authority preparation. These were corrected and then retested, not
retroactively counted as successes.
