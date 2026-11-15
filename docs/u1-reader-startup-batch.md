# Protected-reader startup dispatch (15 November 2026)

The execution renderer sends only the fixed `BEGIN` and three `SET LOCAL`
statements in one psql dispatch, using escaped semicolons and a final `\g`.
The canonical SQL renderer is unchanged. An exact prefix check rejects changed
startup statements, and reversing the transport plus local markers must recover
the complete canonical SQL bytes. Guard and four data-query dispatches remain
unchanged, including their marker boundaries and snapshot decoder.

This removes three startup request/response cycles; it does not remove connection
startup or prove a latency improvement. Marker intervals remain client-observed,
not server-only timings. The 5-second statement, 1-second lock, 15-second process,
32-MiB combined output and zero-retry limits are unchanged. No business SQL,
application code, measured UI interval or successful evidence schema changes.

Local checks: `scripts/u1-reader-diagnostics.nodechecks.mjs` checks exact transport
reversal and rejects startup drift; existing adapter/collector/executor/authority
checks cover unchanged full-envelope admission. Disposable PostgreSQL 17 protocol
proof is a separate prerequisite, not inferred from JavaScript tests. Staging
reliability and the full comparison remain unproved by this source change.
