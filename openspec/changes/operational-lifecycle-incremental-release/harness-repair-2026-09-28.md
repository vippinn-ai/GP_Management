# September 28 staging acceptance harness repair

Scope: test infrastructure only, successor of frozen `712f314`. No application runtime, pricing calculation, database function or production change.

## Observed failures

- Same-target race committed one winner, then attempted cleanup billing with an empty pricing snapshot. The application correctly refused a zero-price bill.
- Unit-sale hop returned HTTP 200, but its asynchronous diagnostic response collector had not populated entity evidence when asserted.
- Downstream checkout committed, but reconciliation selected nonexistent `bill_lines.line_total`; the normalized column is `total`.
- Without a suite-wide failure limit, later files continued after a serial group's failure. The run was interrupted; no acceptance manifest was sealed. Preserve that consumed identity and all partial evidence.

## Test-only changes

1. Read and validate normalized station pricing before direct timed fixture writes. Use India-local start-time coverage, reject missing/ambiguous/nonpositive or sub-rupee fixtures, and preserve the real rules in the start payload. Apply to both concurrency and continuation matrices. Do not weaken zero-bill rules or fabricate items.
2. For recoverable race cleanup, verify the selected customer's continuation banner before issuing; require an enabled button, read the canonical checkout response, and reconcile the exact source's closed bill ID. Keep cleanup bill IDs in race/sample evidence.
3. Track response-body tasks synchronously, expose bounded settlement and disposal, preserve callable detach compatibility, and retain sanitized HTTP evidence for non-JSON bodies. Unit-sale assertions also inspect the actual hop response directly. Await capture settlement before required diagnostic reads.
4. Query and sum `bill_lines.total`; keep bill/payment/receipt parity checks unchanged.
5. Stop Playwright after the first failure (`maxFailures: 1`, one worker, zero retries). Let the runner exit normally to seal failure evidence. Missing/skipped cases remain non-acceptance.

## Required evidence before another live run

- Local executable pricing guard and asynchronous collector tests, including delayed/concurrent/rejected/hung bodies and detached listeners.
- Existing QA contracts, TypeScript, static 14-spec gate, and unchanged 31-case discovery.
- Independent review of the exact successor; no runtime/SQL changes in its diff.
- Exact-ID retirement/reconciliation of the previous run's three QA sessions. Preserve its terminal bill, all inventory, historical mutations, and app_state. Cleanup is a separate guarded staging maintenance action, never a rerun or fake bill.
- Fresh candidate-bound release evidence and unique acceptance identity. Historical database proof may only be reused through a reviewed evidence-binding decision; this document does not waive existing gates.

Local checks are not staging acceptance. Production remains excluded until staging signoff and immediate owner approval.
