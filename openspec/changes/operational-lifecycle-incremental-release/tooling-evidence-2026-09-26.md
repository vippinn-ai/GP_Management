# Local tooling checkpoint, 26 September 2026

This is local preparation, not staging execution or deployment approval. Production and staging were not contacted during this checkpoint. The f85b11a application runtime and four business SQL files remain unchanged; this successor adds tests, test tooling, read-only probes and local SQL-package builders.

## Independent evidence

The independent tester used a separate detached worktree at f85b11a. Initial six-suite gate passed 81/81 with TypeScript, and independently rehashed the original 594-test report. The tester then authored direct v2 invocation tests for all three routes, exact intent payloads, audit rejection, canonical hydration and all 17 legacy fallbacks. The extended six-suite gate passed 88/88; only rpcClient.test.ts changed in that worktree. Evidence remains under sibling lifecycle-v2-incremental-qa-f85b11a/test-artifacts:

- independent-r1-focused-f85b11a.json: a3ef205c63f4b8cdcc961905271daa56de8fe816d66cf4880c4dc94f77b442cd.
- independent-r1-focused-with-routing-f85b11a.json: 7cfd7e2128d248e69c6e6b055b6292557084832a96e67fc55a091a703804e6fe.
- independent-r1-rpc-routing-f85b11a.json: 093d55c699e96b9d19877c6e4eBCD378c4e28045effbc591bfeF7d6228f9dd62 (SHA values are case-insensitive).

The reviewer first rejected unmodified old tooling and then identified three runner-boundary defects. Re-review confirmed the corrected pre-spawn source check, crash-surviving DB/runtime reservation and post-run bundle check, and independently ran 8/8 guard tests. This is bounded runner GO, not final SQL/tooling/staging acceptance. Planned --help and static-checker corrections were subsequently implemented and checked locally.

## Reused scope

Ported the lifecycle installer/reinstall, proof/postrollback/posttest chain, six lifecycle Playwright specs and eight existing regression specs from d4eda24. Retained failure-preserving cleanup, exact identities, physical staging guards, 49 negative SQL cases, 20 operation samples per class and 50 reload/mutation pairs. Restored deferred-export assertions to c0e0d21 behavior-only export parity plus failure-preserving screenshot handling. The fixed config excludes only the optional abandoned-session maintenance test. Global startup, atomic-bootstrap, profiling and customer-profile tooling were not imported.

Reinstated runtime SQL/tooling contracts that were explicitly deferred in the previous extraction; split out the old unrelated startup/deferred-export/customer-profile contract blocks rather than requiring their implementations in R1. These historical tests remain on the mixed branch and are not represented as passed here.

## Executed local checks

- Direct Node runner guard tests: 8/8 passed (argument escapes, bundle origin, exact test identity, actual compact-reporter parity, secret-free runtime input binding, seven-function SQL provenance, source drift).
- Static gate passed: all 14 selected Playwright specs lint/type-check; runner/guards/reporter syntax and dedicated zero-warning lint; Playwright config typing.
- Offline JSON discovery passed: 31 tests listed, zero tests executed, no browser launched, no compact live summary written.
- Final affected Vitest gate: 81/81 passed. test-artifacts/r1-tooling-final-focused-20260926.json SHA256 e418b48b80a71ac7f9080f698f29b5a20a6df037571884873b863110fd5788e2.
- TypeScript project build passed. Source lint: zero errors and four existing warnings.
- Complete final suite passed: 65 files, 629/629 tests, zero failed suites, success=true and process exit zero. test-artifacts/r1-tooling-full-final-20260926.json SHA256 54df29ea2be2005213965a6845bd51fcc5fa05bb72a149cd3fbb573facc06d62. Separate Node guard checks remain 8/8 passed.

## Preserved failures and corrections

An initial bulk-read attempt exceeded output capacity and did not apply any patch; subsequent per-file transfer used apply_patch. Local tool launches encountered a wrong dependency-relative path and Windows sandbox config access; these did not execute tests. Dependencies were resolved from the existing workspace, without installing packages.

The first 58-test tooling run passed 57 and failed an absent old-runbook reference. The R1 runbook now supplies the same strict operation budget. The corrected 58-test run passed. The first full 629-test run passed 627 and failed two old v1-only textual harness assertions; ported the historical v1/v2 intercept and canonical-audit assertion corrections. The subsequent focused 81-test run passed. No failed evidence was deleted or relabeled.

The next full run passed all 629 assertions but still exited nonzero: Vitest attempted to bundle the separate Node built-in test runner from lifecycle-runner-guards.test.mjs. Renamed that Node-only file to lifecycle-runner-guards.nodechecks.mjs and retained its separate node --test execution. This was a test collection error, not a passing full gate; the failed report is retained.

## Remaining independent/live gates

Freeze the exact successor and independently review/test the complete SQL-package/probe/security changes, runtime-input/source/bundle binding and scope. Current local security fixtures do not execute PostgreSQL. Verify real installed definitions read-only, choose the matching installer mode without fallback, bind a fresh staging dataset/scale/proof chain, run the actual 31-case suite, and reconcile/clean up all exact IDs. Then obtain exact-candidate reviewer/tester acceptance plus backup/rollback validation before requesting immediate production approval.
