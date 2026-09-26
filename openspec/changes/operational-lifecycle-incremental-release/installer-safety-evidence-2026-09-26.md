# Installer safety corrections, 26 September 2026

Local successor to 98406b1; no database request, browser test, push or deployment occurred. Application runtime and four business SQL files are unchanged. This is not live staging or production acceptance.

## Corrected review findings

- Both builders and verification require the same clean expected Git commit and full source hash. Preflight/postflight SQL is hashed; generated postflight carries run/source identity.
- Initial mode requires absent table/v2 trio/dataset helper both in saved evidence and before DDL. Strict CREATE refuses concurrent appearance. All five app_state identity fields are checked.
- The seven functions have a source-defined, exact owner/metadata/ACL contract, separate from immutable predecessor restoration. Reinstall rejects unexpected metadata or preserved bodies.
- Postflight requires zero sessions/tabs/recoverable hops/incomplete mutations and rejects missing evidence.
- Original rollback guards all seven installed functions before restoration, proves exact predecessor restoration and unchanged compatibility state, and never drops the mutation table or deletes committed rows.
- Bounded follow-up review added exact unique six/ten-function preflight sets; table security guards before/after rollback; forced-RLS rejection; and full server-version binding. PG15/16 have seven owner table privileges, PG17 additionally MAINTAIN, unsupported versions fail closed. See the runbook's official PostgreSQL source.

## Executed local evidence

- Full Vitest: 65 files, 631/631 tests, zero failed suites, success=true, process exit zero. Report `test-artifacts/r1-safety-full-20260926.json`, SHA256 `e01d3dc83f592caefcb18015db6f05714868366d22ec762a881878fd96acc4c9`.
- Independent tester-authored installer matrix: 7/7 passed in 115.56 seconds using disposable committed Git fixtures. TypeScript, file ESLint and diff check passed. Test source SHA256 `6aee5e9ea891eb2c9b54de3207a1abb4eacfaafd07297c02f8937c1d8aaafd97`.
- Direct Node runner guards: 8/8 passed. Expanded static gate passed for all 14 selected Playwright specs plus runner/install scripts and config.
- Source lint: zero errors, four existing warnings. TypeScript project build passed. No build was repeated because runtime/build sources and business SQL are unchanged; prior ON/OFF build evidence remains separately dated.
- Fresh branch graph: 380 files, 15,880 nodes, 41,932 edges; source fingerprint `12975999d9fb708ecb8699c4d9ea7d23d9a646842118621805f5c40ca6901472`. Static edges are not runtime coverage.

The reviewer issued bounded source GO for the corrected metadata/provenance/rollback contract, the three follow-up defects, and version binding. Final exact-clean-commit decisions remain separate; this file does not approve an executable live package.

## Preserved failures and limits

Windows sandbox prevented Vite/esbuild startup; the identical local command then ran with reviewed directory access. The expanded static checker found one unused verifier variable, which was removed. The tester's first negative body-drift fixture accidentally left the body unchanged; it failed, was corrected to a real body change, and the corrected focused/full suites passed. These failures were not relabeled as passes. A pre-version 6/6 fixture run is superseded by the final 7/7 matrix.

Next: clean exact-SHA independent review/testing, fresh read-only staging preflight/installed SQL comparison, mode selection and immutable package review, followed by the scoped live correctness/performance/rollback suite and reconciliation. Production requires final release acceptance, backup/rollback readiness and immediate owner approval.
