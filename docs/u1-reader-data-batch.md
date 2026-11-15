# Protected-reader data dispatch

This test-only change batches the existing five runtime data SELECT statements
into one psql dispatch. It does not change application code, server SQL statements,
the repeatable-read transaction, physical staging guard, rollback, full 33-table
scope, or strict five-record reconstruction. Canonical preflight and authority
rendering remain unchanged.

The fixed-SQL lexer preserves quoted text, Unicode, dollar quotes and nested
comments. Inverse transport reconstruction must equal the original SQL bytes.
Unsupported client commands, variables and malformed input fail closed. The
5-second per-statement timeout, 1-second lock timeout, 15-second reader deadline,
combined 32-MiB output limit and zero retries remain unchanged.

Runtime diagnostics record guard boundaries and `data_batch_before/after` only.
They cannot attribute time to an individual statement. Historical ten-marker
diagnostics remain readable; mixed sequences are rejected. Failure prefixes never
validate a partial data snapshot.

Before integration, the equivalent private transport passed native PostgreSQL 17
data/timeout/cleanup checks and one read-only staging observation with exact
app-state version 758 and all 33 protected tables unchanged. The staging reader
took 9.186 seconds. This single observation is compatibility evidence, not proof
of reliable latency, UI improvement, campaign acceptance or production readiness.

Local tests cover transport reversal, lexical rejection, both diagnostic formats,
full-data reconstruction, timeout/output failure handling and unchanged downstream
admission. Independent regression testing and fresh campaign admission remain
separate gates. Production is excluded.
