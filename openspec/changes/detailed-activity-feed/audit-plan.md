# Independent audit plan

The auditor is not the implementer or functional tester and works from a separate clean worktree.

1. Trace every public mutation entry point to an audit row or operational fallback.
2. Confirm actor/time are server-canonical and spoofing cannot alter attribution.
3. Verify append-only grants, RLS, SECURITY DEFINER ownership/search paths, and tenant isolation.
4. Verify idempotency, rollback behavior, legacy backfill reconciliation, and no duplicate presentation events.
5. Inspect allowlisted details for secrets, excessive customer data, and stored-XSS risk.
6. Verify cursor/filter SQL, indexes and production-scale plans.
7. Verify feature-flag rollback and that business calculations did not change.
8. Match source commit, SQL fingerprints, Worker version, bundle hash, and tester evidence.

The verdict must be GO or NO-GO with every issue classified critical, major, minor, accepted, or resolved. Production remains blocked unless both tester and auditor return GO.
