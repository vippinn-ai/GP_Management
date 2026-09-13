# Design

## Incremental delivery

### A. Normalized lifecycle commands

Add `operational_mutations`, `hop_session_v2`, `reject_session_v2`, and `reject_customer_tab_v2`. Add `VITE_BACKEND_OPERATIONAL_RPC_V2`, default `false`, with fail-closed dependencies on normalized bootstrap/live reads, compact realtime, and operational RPC writes.

### B. Continuation and canonical convergence

Harden `start_session`, `open_customer_tab`, and `link_customer_tab_continuation` actor attribution. The new-tab continuation path must lock/validate source hops exactly like the existing-session/game paths. All continuation-bearing commands become non-optimistic, manual-retry, acknowledgement-required; UI state advances only after canonical confirmation.

The target v2 response lists changed normalized IDs. Before resolving a critical acknowledgement, the origin loads those rows and merges them through the normalized overlay. It must not reapply a client snapshot after hydration. Observer events are serialized or guarded against stale completion so response-first, realtime-first, and reversed fetch completion converge.

### C. Startup bundle

Move `jspdf` and `xlsx` behind analyzable user-triggered dynamic imports. Preserve synchronous popup creation before awaited work to avoid browser popup blocking. Keep receipt preview construction light and eager. This is a separate commit and release toggle from SQL behavior.

The selected React renderer is a build-time static dependency: ordinary builds use `react-dom/client`, while the explicit performance-evidence build aliases that import to `react-dom/profiling`. This removes the pre-mount dynamic-renderer waterfall without including both renderers. Non-dashboard panels are route-lazy and share one accessible loading boundary. The shared logo is preloaded when the entry executes so remote restore does not delay discovery of the LCP image. Inventory mounts only the desktop table or the mobile card list matching the active media query and calculates each displayed item's availability/state once; resize switches layouts without changing catalog actions or data.

### D. Bootstrap/sync gap

Wait for a confirmed `SUBSCRIBED` realtime status, then buffer compact events before critical snapshot restore and replay/deduplicate them before enabling writes. This subscription-ready barrier removes the snapshot/subscription gap without relying on a best-effort timer. Split critical operational bootstrap from screen-gated history/report/customer/audit data and parallelize independent reads after organization resolution. The app remains read-only until critical data and buffered catch-up are complete. This unit is required before claiming stale-sync elimination, but is independently reversible from A-C.

### E. Atomic critical bootstrap

The measured candidate remains functionally correct and materially faster, but its separate identity, realtime, and normalized-snapshot waves cannot credibly meet the absolute startup gate. The next unit keeps the subscription-ready invariant while overlapping a small startup coordinator's single App-module import with one shared realtime preparation. After the authenticated session subject exists and the same channel reports `SUBSCRIBED`, the client invokes exactly one versioned `load_operational_bootstrap_v2()` RPC. StrictMode, restore retries, and the mounted subscription must adopt the same attempt-scoped client, channel, promise, and event buffer; they must not create duplicate channels or calls.

The RPC accepts no actor or organization input. It derives `auth.uid()`, checks active profile status before organization integrity so inactive/missing access wins deterministically, and requires exactly one active membership in one active organization. It is authenticated-only, `STABLE`, read-only, tenant-predicated, cardinality-bounded, and returns a fixed raw normalized-row envelope: actor and staff profiles, organization/business profile, lightweight `app_state` version metadata, configuration, catalog/variants, combos/children, open or recoverable sessions/children, and open customer tabs/children. Bills, payments, expenses, audit history, stock-movement history, and `app_state.data` remain forbidden. Existing client builders map the envelope so a second application-shaped server model is not introduced.

The server includes `organization_id` on every tenant row and enforces a 160,992-byte response ceiling. The client validates the exact envelope and row field sets, contract version, actor/profile equality, organization, unique IDs, row bounds, tenant relationships, and required fields before assigning identity. Buffered events are filtered to the selected organization, replayed once in their existing serialized order, and deduplicated before safe interaction. A no-session result never subscribes or invokes the RPC. Inactive/revoked access, role mismatch, ambiguous organization state, subscription timeout/disconnect, malformed or oversized RPC data, buffer overflow, cancellation, account change, or catch-up failure removes the channel, clears cached tenant identity, discards the attempt and buffer, and leaves the application blocked or cached-read-only. This first version retains subscription-before-snapshot; it does not introduce a watermark protocol.

The unit is controlled by a new default-off frontend flag and an additive SQL definition. Its installer is bound to immutable read-only staging preflight evidence for physical environment identity, `app_state`, open work, incomplete mutations, prior function definition/owner/configuration/ACL, and the realtime RLS policy/helper/publication. Its read-only postflight executes the RPC inside a read-only transaction and records the exact contract, payload size, grants, version, and collection counts. Disabling the flag returns startup to the already-deployed normalized REST path without changing normalized write authority. Rollback restores the exact captured function/owner/ACL when one existed, otherwise drops the additive function; neither path changes application rows.

## Trust boundary

Normalized operational tables are authoritative. V2 payloads contain intent and stable IDs: organization, mutation ID/kind, entity type/ID, client-created time, effective close time, audit ID, and rejection reason where applicable. The server rejects actor and `base_app_state_version` fields, derives `auth.uid()`, verifies active membership/role, and patches only whitelisted canonical fields. Items, combos, customer, station, pricing, start time, LTP, and source continuation data remain server-owned.

## Idempotency and locks

`operational_mutations` is keyed by `(organization_id, mutation_id)` and stores kind, entity, actor, request fingerprint, status, canonical result, and timestamps.

1. Validate envelope and authorization.
2. Serialize first insertion by organization/mutation advisory lock; insert or lock mutation row.
3. Return stored committed result only when identity/fingerprint match; otherwise `mutation_identity_mismatch`.
4. Lock target session/tab.
5. Lock the target session's open pause rows in time/ID order.
6. Validate current state and audit ID.
7. Write closure, pause, audit, compact event, and canonical result atomically.

Independent entities share no global lock. A failure rolls back every write.

## Lifecycle rules

- Hop requires an open, unbilled session, canonical start, valid effective end, and agreement between session status and open-pause rows. It closes exactly one canonical open pause only when the session is paused, sets `closed/hopped`, forces bill/reason null, and preserves other canonical fields and continuation IDs.
- Reject requires an open, unbilled session/tab, trimmed reason, valid close time, and a valid pause invariant. It closes an open session pause, sets `closed/rejected`, clears bill and continuation IDs, and preserves items/combos for audit.
- A continuation source must be closed/hopped/unbilled/unconsumed and match the target customer identity. Same-ID replay is accepted only when the stored request fingerprint matches the complete intent; entity and audit ID collisions fail atomically.
- The server constructs audit message/time/actor. No bill, payment, stock, or inventory row changes.
- `raw_data` is patched minimally from locked canonical raw JSON; a client entity snapshot is never stored.

## Realtime and recovery

Events contain changed normalized IDs, mutation identity, duration, and released continuations; no full entity or `app_state` version is required. Stale unrelated compatibility drift does not block v2. A closed target returns a stable conflict with no partial writes. A lost response is recovered only by same-ID replay. Hydration failure remains explicit and recoverable; it never causes a new-ID automatic retry.

The atomic startup attempt is also single-shot. A failed or ambiguous session, realtime, RPC, mapping, or catch-up promise remains cached and cannot be retried by a timer, remount, or StrictMode effect adoption. Only an explicit user retry signal tears down the prior channel and creates one fresh attempt; the same retry signal is consumed once. When the atomic flag is off, the build uses the retained static application entry so this optimization adds no default-off chunk waterfall.

Every atomic attempt has an internal generation. Explicit sign-in/sign-out/reset invalidates the previous generation immediately, and asynchronous session, RPC, and realtime-hydration boundaries recheck it before publishing organization identity, cache, or snapshot state. A late response from account A must fail as superseded and cannot clear or overwrite account B's newer attempt.

Invalidation actively rejects a still-pending realtime-ready barrier and unsubscribes its channel, so an unadopted preparation cannot hang until its ten-second timeout. Installer preflight, install, postflight, and rollback compare canonical function bodies with an executed CRLF/CR/LF normalization self-test and accept exactly one applicable `PERMISSIVE`, authenticated, tenant-helper policy for `operational_events`.

A post-ready realtime disconnect tears down the channel and invalidates the generation but replaces the reusable preparation/load promises with a cached rejection. Remounts therefore remain read-only and cannot create another session, channel, or RPC until one explicit manual reset. Likewise, a superseded subscription's delayed hydration failure is generation-filtered before it can warn or notify the newer account's listener.

## Rollback

Disable the operational-v2 flag to return new target commands to retained v1 functions while normalized reads remain enabled. Keep v2 functions/table installed so evidence remains. A full compatibility-read rollback requires separately verified normalized-to-`app_state` reconstruction. Bundle and bootstrap units have independent frontend rollback commits/flags.

## Deferred stock-movement pagination

Inventory history remains outside the critical bootstrap graph. Its normalized reader requests at most five exact-count ranges of 1,000 rows, reapplies the organization/date filters and deterministic `movement_at desc nulls last, id desc` database order to every range, and enforces one 15-second wall-clock deadline across the complete read. It rejects missing or drifting counts, null data, duplicate IDs, non-monotonic movement timestamps, short/oversized/empty early pages, API failures, timeouts, and incomplete totals. The caller continues to reject a saturated 5,000-row result so partial history is never presented as complete. The client does not reinterpret PostgreSQL's secondary text order with JavaScript string comparison because their collations are not generally equivalent; executable query tests require both database order clauses on every page, while runtime overlap detection protects the page boundary.

This bounded offset pagination is accepted only for the deferred, read-only, append-only stock-movement audit stream. Concurrent changes can shift offsets, so count drift, overlap, timestamp-order violations, and page-shape mismatches fail to the existing retryable read-only error instead of silently returning mixed history. It is not an authorization to use offset pagination for mutable financial or lifecycle state.

## Performance evidence clock and byte semantics

Performance evidence version 2 uses the document's browser clock as the only critical-path time domain. An initialization-time in-page observer creates `bp-visible-dashboard-ready` from the same rendered, visible `Live Dashboard` boundary in both legacy and candidate builds; this common mark drives the relative latency and critical-request comparison. The candidate's application-created `bp-safe-interactive` remains a separate correctness and absolute-budget gate. Playwright observation lag is retained separately and never selects critical requests. Request correlation uses a SHA-256 URL fingerprint plus per-URL occurrence, reconciles request, resource, and response evidence bidirectionally, and fails closed on missing, duplicate, inverted, non-finite, negative, failed-status, or invalid decoded-body/transfer evidence. Browser resource timings provide request start and network response end, so body buffering, JSON parsing, gzip evidence calculation, and assertion polling cannot inflate the dependency graph.

Critical API payload bytes remain decoded response bytes. Cold-shell bytes are same-origin navigation and resource `transferSize` values (encoded transfer plus protocol overhead), while decoded and locally gzipped JavaScript remain separate bundle metrics. Deferred requests retain signed start-versus-safe offsets, deferred financial classification includes bill and line discounts, and LCP evidence records only a sanitized element selector and resource path. Every threshold uses soft assertions after the immutable evidence is attached so one failure cannot hide the others.

The normalized restore resolves the current profile and active organization in the same authenticated network wave. The two results settle independently so a confirmed inactive or missing profile always revokes application access even when the organization lookup fails; an active profile with no verified organization remains fail-closed. The verified organization is then passed into normalized bootstrap, removing its former serial organization lookup while preserving the established subscription-ready-before-snapshot and buffered catch-up order. Application identity is activated only after the authoritative snapshot and buffered catch-up are applied. The operational queue independently requires restore state `ready` and remote loading complete, and reschedules once those conditions become true, preventing persisted mutations from dispatching against pre-restore state. The Inventory panel chunk is requested only after safe interaction during browser idle time or earlier on explicit Inventory navigation intent; evidence requires that request to remain post-safe.
