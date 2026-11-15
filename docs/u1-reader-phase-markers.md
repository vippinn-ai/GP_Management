# Test-reader client phase diagnostics

This test-only change instruments `createProtectedReader` execution with ten fixed
psql-local `\warn` lines around the existing guard and four SELECT statements.
Removing those lines restores the canonical SQL byte-for-byte. The default
renderer, transaction, predicates, hashes, and snapshot decoder are unchanged.
There are no additional server queries, reads, retries, or evidence records.

Failed reads may include optional bounded `phases` metadata in the existing
failure diagnostic. It contains only fixed phase names and nonnegative integer
client-relative arrival times, plus spawn/stdin/first-output/close milestones.
These durations include transport and client processing; they are not server
execution timings. A valid ordered prefix is useful on timeout, but never proves
snapshot completeness. Invalid markers discard phase metadata, not the original
failure code. Unknown stderr, credentials, SQL, and request payloads are not kept.

Success still depends solely on the existing complete four-part snapshot decoder;
markers do not add success fields or become snapshot authority. Legacy failure
diagnostics without `phases` remain accepted. UI sample timing is untouched.

SQL 5-second, lock 1-second, process 15-second, and 32-MiB output limits remain.
The existing 32-MiB output cap is now enforced against stdout plus stderr, a
stricter implementation of the combined budget rather than a larger allowance.
The marker parser itself retains at most 32 KiB and ten allowlisted markers.

Focused tests cover exact SQL restoration, partial/complete markers, split UTF-8,
malformed/duplicate/out-of-order/oversized input, sanitized terminal propagation,
stdout-only/stderr-only/combined overflow, and unchanged successful snapshots.
Local tests and historical private psql protocol evidence are not live staging
verification or performance acceptance.
