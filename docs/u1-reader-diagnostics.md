# U1 verification-reader diagnostics

## 2026-11-15 diagnostic extension

The original scope and fixed-code/numeric-only contract below describe the first
diagnostic revision. They are extended by [client phase markers](u1-reader-phase-markers.md):
failures may now carry optional bounded, allowlisted `phases` metadata. Canonical
server SQL remains unchanged, while the executed psql input adds local `\warn`
commands. The same 32-MiB budget is enforced more strictly across stdout plus
stderr. Successful snapshots and terminal records remain unchanged. See the
linked page for current marker validation and client-timing limitations.

## Scope

The first reader comparison stopped after one confirmed session start and before
any completed performance sample. Its coordinator discarded the original error.
Subsequent guarded cleanup reads hit PostgreSQL statement timeouts without
submitting a rejection. These observations do not prove an application defect.

This test-harness-only change retains diagnostic categories in the existing
failed terminal record. Application code, SQL text, query partitions, payloads,
business rules, successful terminal records, limits and retry behavior do not
change. It does not authorize another staging attempt or production deployment.

## Contract

The protected reader reports one of `U1_READ_TIMEOUT`, `U1_READ_OUTPUT_LIMIT`,
`U1_READ_SQL_TIMEOUT`, `U1_READ_EXIT`, `U1_READ_PROCESS`, `U1_READ_STDIN` or
`U1_READ_FORMAT`. SQL timeout classification requires the specific PostgreSQL
English diagnostic marker; other nonzero exits are not guessed to be timeouts.

Only the fixed code and nonnegative safe-integer read ordinal, elapsed milliseconds,
stdout/stderr byte counts, stdout newline count, and a nullable exit code may be
retained. Newline counts are transport observations, not validated fragment counts.
Raw stderr, SQL, error messages/stacks, tokens and credentials are never copied
into the terminal record. A bounded 64-character in-memory suffix only supports
marker matching across stderr chunks.

The coordinator retains execution and postflight diagnostics separately. Unknown
errors become `U1_UNCLASSIFIED_FAILURE`. Postflight remains mandatory, failed
runs remain failed, and no second mutation or automatic retry is introduced.
The existing terminal record receives `failureDiagnostics` only on failure;
success records and total evidence-record limits are unchanged.

## Local checks

Run `node --test scripts/u1-reader-diagnostics.nodechecks.mjs
scripts/u1-playwright-runner.nodechecks.mjs`. Check malformed/hostile diagnostics,
split timeout markers, ordinary exits, stdin/process/format failures, output and
time limits, ordinal accounting, raw-secret exclusion, mandatory postflight,
preserved original failure and unchanged success shape.

Also run the existing collector/authority/command/runtime/admission suites after
updating live source fingerprints. Their 250-phase fixtures must use an isolated
working directory: parallel invocations in the same directory share fixed fixture
identities and intentionally refuse collisions. Do not delete another run's files
or relax those assertions to make a test pass.

Independent review and testing, exact-source freeze, and fresh staging admission
remain required. Local tests are not a measured UI improvement or release signoff.
