# Candidate checklist

- [x] Reproduce the production frontend entry from the recorded base, exact SHA256 match.
- [x] Create isolated codex/lifecycle-v2-incremental worktree; preserve mixed branch and root WIP.
- [x] Extract lifecycle client, SQL and directly required sync/continuation code; exclude startup and panel work.
- [x] Add regressions for non-atomic overflow, overlapping snapshot reads and disconnect-mid-queue.
- [x] Complete local full-suite/type/lint/build gates; see local-evidence-2026-09-26.md (594 tests, source lint zero errors/four baseline warnings, both builds pass).
- [ ] Freeze candidate identity after recording independent review disposition.
- [x] Independent bounded re-review closed the two extraction correctness blockers; no remaining concrete blocker in those repaired paths.
- [ ] Obtain broader exact-candidate reviewer/tester approval for staging preparation.
- [ ] Bind reusable staging installer/proof/Playwright/cleanup tools to this release without global startup gating.
- [ ] Verify installed production baseline SQL read-only; no production writes.
- [ ] Execute scoped staging functional/security/recovery/concurrency/performance matrix.
- [ ] Reconcile/clean up and obtain exact-candidate independent tester and reviewer release acceptance.
- [ ] Prepare backup/rollback/deployment package; request immediate production approval.

The first focused run passed 76 tests. A later 80/81 run rejected an invalid second audit fixture whose inner entity ID differed from its envelope; that failure report is preserved. Corrected two-case App queue suite and subsequent full 594-test run passed. These are local findings, not staging acceptance.
