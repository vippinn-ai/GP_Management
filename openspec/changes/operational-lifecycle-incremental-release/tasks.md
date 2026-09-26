# Candidate checklist

- [x] Reproduce the production frontend entry from the recorded base, exact SHA256 match.
- [x] Create isolated codex/lifecycle-v2-incremental worktree; preserve mixed branch and root WIP.
- [x] Extract lifecycle client, SQL and directly required sync/continuation code; exclude startup and panel work.
- [x] Add regressions for non-atomic overflow, overlapping snapshot reads and disconnect-mid-queue.
- [x] Complete local full-suite/type/lint/build gates; see local-evidence-2026-09-26.md (594 tests, source lint zero errors/four baseline warnings, both builds pass).
- [x] Freeze initial runtime identity f85b11a6503f11ff9286be8e6b1a81ccc9bd8637; later tooling successor still requires exact-candidate review.
- [x] Independent bounded re-review closed the two extraction correctness blockers; no remaining concrete blocker in those repaired paths.
- [ ] Obtain broader exact-candidate reviewer/tester approval for staging preparation.
- [x] Implement the five 98406b1 reviewer safeguards: clean source provenance, runtime initial-mode/full baseline checks, exact function metadata/ACL, complete postflight floor, and original rollback drift checks.
- [x] Address bounded follow-up findings: exact preflight function sets, rollback table-security guards, forced-RLS rejection, and PostgreSQL-version-bound owner privileges.
- [x] Complete the new executable negative matrix and full suite: 7/7 focused installer cases, 631/631 full tests, Node 8/8; see installer-safety-evidence-2026-09-26.md.
- [x] Freeze safeguard successor 32a6f3d727bb54e9a1573922aaf8faa9176b163e and obtain exact-SHA independent preparation-only decisions. Bounded source GO is not SQL execution approval.
- [x] Capture complete staging table/function security read-only; all ten bodies match, seven function grants and eight table grants differ from the intended contract.
- [x] Implement a separate fifteen-privilege convergence package, exact inverse and source-bound verifier; retain strict initial/reinstall refusal on unexpected ACLs.
- [ ] Complete independent ACL-specific negative/CLI tests and freeze the reviewed tooling successor.
- [ ] Execute the reviewed staging-only ACL correction once and verify immutable postflight; no matching function-body rewrite.
- [x] Independent tester verified initial runtime in a separate detached worktree: 81/81 focused tests, TypeScript and full-report hash; GO for tooling preparation only.
- [x] Add tester-authored direct v2 routing/payload/hydration/audit matrix and all 17 legacy fallback kinds; independent focused total 88/88 passed.
- [x] Port lifecycle-only reusable tooling; static check covers 14 specs, runner/helper/reporter syntax/lint and Playwright config typing. Offline discovery is 31 cases, zero executions.
- [x] Correct runner overrides, complete-test identity, crash reservation, runtime inputs and pre/post bundle/source drift checks; bounded reviewer recheck passed, not release approval.
- [x] Implement preserved-SQL source checks, portable body comparison, all-privilege/policy postflight rejection and negative local fixtures. Broader independent SQL/tooling review remains open.
- [ ] Bind reusable staging installer/proof/Playwright/cleanup tools to this release without global startup gating.
- [ ] Verify installed production baseline SQL read-only; no production writes.
- [ ] Execute scoped staging functional/security/recovery/concurrency/performance matrix.
- [ ] Reconcile/clean up and obtain exact-candidate independent tester and reviewer release acceptance.
- [ ] Prepare backup/rollback/deployment package; request immediate production approval.

The first focused run passed 76 tests. A later 80/81 run rejected an invalid second audit fixture whose inner entity ID differed from its envelope; that failure report is preserved. Corrected two-case App queue suite and subsequent full 594-test run passed. These are local findings, not staging acceptance.

The tooling port initially failed an absent old-runbook reference, then the full suite exposed two old v1-only textual harness assertions. The corrected assertions retain v1/v2-compatible interception and canonical audit evidence. All failed reports remain preserved; see tooling-evidence-2026-09-26.md. No test runs were relabeled and no live mutation was retried.
