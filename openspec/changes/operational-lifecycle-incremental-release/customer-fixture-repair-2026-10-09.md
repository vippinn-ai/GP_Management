# October 9 customer fixture repair

Status: test-only implementation has independent local reviewer/tester GO and broader QA223/223 passed; fresh staging acceptance remains a separate gate.

## Evidence and scope

The single zero-retry run `normops-20261009-1000-acceptance-ffe204a` stopped in its first test; 30 cases were not run. The same-target hop race produced one winner and one `session_not_open` loser, but follow-up checkout returned HTTP 400. Staging Postgres log `e5a15aeb-1f33-4b78-9894-ad45e1d2e0d8` identified `invalid_customer_scope` at 15:34:52 IST. Postflight found zero bills, payments and financial mutation rows for this run, unchanged app_state, and one unbilled recoverable QA hop. Prior staging frontend was restored and the three fresh QA accounts deactivated.

Source tracing finds direct named-session fixtures omit the normal UI's customer payload. Normalized client loading can synthesize a customer locally, while checkout only sends changed profiles. This explains a possible missing persisted identity; the exact failed request body was not retained, so it is not a captured-payload proof. Do not weaken the financial SQL identity guard.

## Bounded correction

- Test-created named sessions and tabs must follow the real start/open RPC customer contract, using run-unique identities. Verify persisted source-to-customer linkage before the race.
- Inspect every direct fixture creator in the selected 14-file/31-case suite, including continuation targets. Avoid changing anonymous fixture semantics without evidence.
- Retain sanitized checkout failure identity/code/status before asserting success. Never retain credentials or unrestricted customer payloads.
- Settle and dispose asynchronous evidence collectors in failure-preserving teardown. A diagnostic failure must not hide the original checkout failure.
- No application runtime, database function, pricing rule, retry count or acceptance threshold changes in this successor.

## Independent local test contract

1. Executable tests for unique customer fixtures, matching source/profile fields and fail-closed invalid identity inputs.
2. HTTP 400 diagnostics survive an assertion failure; delayed response collectors finish within existing bounds; disposal detaches listeners.
3. Existing QA contracts, TypeScript and static suite checks continue passing. Discovery remains 31 cases, one worker, zero retries and maxFailures 1.
4. Independent reviewer inspects exact diff and tester reports executed cases separately from blocked/not-run cases.
5. Characterize the legacy named/no-persisted-customer path separately; do not dismiss it as impossible or bundle an unreviewed product fix.

## Before another staging acceptance run

Retire only `normops-20261009-1000-acceptance-ffe204a-same-1` through independently reviewed, fresh-state-bound staging cleanup with rollback rehearsal and separate durable postflight. Preserve historical mutations/events and all financial data; never manufacture a cleanup bill. Prepare fresh source-bound proof and a new run identity. Prior failed evidence remains immutable. No production action is authorized by this document.

## Separate legacy-customer follow-up

Exact successor source review confirms an existing compatibility edge: normalization may synthesize a customer for an old named source with no persisted customer ID. Checkout can carry that synthetic ID on the bill/source while omitting the byte-unchanged profile from the changed-only customer patch. The v2 SQL guard rejects the missing profile with `invalid_customer_scope`; it does not commit an orphan customer reference. This behavior predates R1. Live prevalence has not been measured.

Keep an executable characterization of the local normalization/patch interaction. A future product change needs an explicit identity/backfill policy and read/search/report regression checks; do not automatically merge people by name or weaken the SQL guard. It is not part of this test-only repair or evidence that current ordinary creation flows are broken.

## Local review outcome

Independent reviewer and tester each executed the final four focused files: namedCustomerFixture, checkoutFailureEvidence, rpcEvidenceCollector and legacyCustomerCheckoutCharacterization (31 tests passed). TypeScript build and scoped ESLint passed. Parent's separate static14-spec gate and eight runner-guard tests passed. Source-first continuation canonical identity and error-envelope sanitization were corrected during review, before any new live run. Reviewer GO is bounded to this local test-only change; legacy SQL assertions are source characterization, not executed database semantics.

The wider QA suite initially failed three temporary-Git lineage fixtures while reading a source blob, including an elevated diagnostic run. The exact environment cause was not conclusively isolated. A subsequent bounded run with shorter workspace-local TEMP/TMP (`test-artifacts/tmp-qa` under the parent repository), one worker and elevated local-process permissions passed all33 files/223tests in255.95seconds. Earlier interrupted/failed attempts remain failures, not passes. No assertions or acceptance thresholds were changed to obtain this result.
