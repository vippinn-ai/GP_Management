# Protected runtime state pieces

The test-only protected runtime reader now sends the stable state/floor fragment
as exactly two raw JSON-text character pieces, followed by the same three table
fragments. Each piece binds total UTF-8 bytes, Unicode codepoints, SHA-256,
snapshot, backend and transaction identity. Reconstruction rejects incomplete,
mixed, reordered or altered pieces before the unchanged full33-table decoder.
No fallback accepts the old four-line format on this explicit runtime route.

Canonical `renderProtectedReadParts` / `reassembleProtectedRead` and preflight /
authority paths remain unchanged; their capture timestamps may be volatile and
must not be regenerated for pieces. `createProtectedReader` alone uses
`renderProtectedReadRuntime` / `reassembleProtectedRuntime`. Startup batching and
ten client-observed phase markers remain; part0 spans both piece statements.

All existing limits remain:5s per SQL statement,1s lock,15s process and32MiB
combined stdout/stderr. Character halves need not be equal byte sizes; neither
piece introduces a smaller16MiB cap. Unicode counting avoids a per-character
array. Both complete reconstruction and canonical output retain32MiB bounds.
The stable state expression is evaluated twice in the same read-only repeatable
read transaction. This is not a claim of lower database cost, UI speed or
campaign acceptance. No application, RPC or business mutation code changes.

Focused self-contained tests cover exact canonical parity, Unicode/escaping,
strict negative transport cases, startup/marker preservation and existing
bounded process failure diagnostics. Native prototype and one staging diagnostic
are prior evidence, not execution of this new integrated checkout.
