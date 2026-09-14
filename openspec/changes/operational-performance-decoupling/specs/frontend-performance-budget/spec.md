## ADDED Requirements

### Requirement: Export libraries are demand loaded
Spreadsheet and PDF generators SHALL load only after an export action needs them and SHALL NOT be in the initial entry path.

#### Scenario: No export is requested
- **WHEN** a user signs in and operates sessions
- **THEN** jsPDF/XLSX chunks are not requested

#### Scenario: An export is requested
- **WHEN** a user selects PDF/XLSX/receipt export
- **THEN** popup-safe loading produces compatible output or a visible recoverable error

### Requirement: Noncritical data is screen gated
History/report/customer/audit data SHALL not block safe dashboard readiness and writes SHALL remain disabled until critical snapshot catch-up is complete.

#### Scenario: Dashboard becomes safely interactive
- **WHEN** authenticated startup has restored configuration, catalog, combos, live operational entities, and buffered realtime changes
- **THEN** writes become available without waiting for bill history, reports, customer history, stock-movement history, expense administration, or audit history

#### Scenario: Dashboard activity is available before financial history
- **WHEN** the deferred audit activity read completes while bill, payment, or expense history is still loading
- **THEN** the Dashboard renders a three-entry one-line recent-activity preview without waiting for financial history
- **AND** Show All opens the complete Activity screen

#### Scenario: A production-shape Inventory catalog is displayed
- **WHEN** the complete canonical catalog contains 112 matching items
- **THEN** Inventory renders no more than 40 rows or cards per page while pagination and full-set search expose every matching item
- **AND** pagination does not truncate canonical stock, report, export, edit, or movement behavior

#### Scenario: Deferred stock history exceeds one server response page
- **WHEN** Inventory requests complete normalized stock-movement history containing more rows than the PostgREST response cap
- **THEN** the application loads the complete requested history into canonical state through bounded, exact-count, deterministically ordered pages and renders the configured recent subset
- **AND** any missing, drifting, overlapping, out-of-order, timed-out, or incomplete page produces a visible retryable read-only error without presenting partial history as complete

### Requirement: Atomic bootstrap meets an independently evidenced critical-path budget
The staging candidate SHALL expose browser-clock marks for App import, session, realtime, RPC, mapping, catch-up, and safe interaction and SHALL retain response/resource correlation evidence.

#### Scenario: Fresh 30-load candidate race
- **WHEN** a single unique zero-retry 30-load race runs against the frozen same-scale staging dataset
- **THEN** safe interaction p95 is at most 3,500 ms and maximum at most 5,000 ms, pre-navigation Login LCP p75 is at most 2,500 ms, bootstrap RPC p95 is at most 800 ms and maximum at most 1,200 ms, and catch-up-to-safe p95 is at most 100 ms and maximum at most 200 ms
- **AND** dependency depth is at most two, there is one critical bootstrap RPC, its decoded response is at most 160,992 bytes, and no direct profile, organization, history, report, audit, or `app_state` read occurs before safe interaction
- **AND** metric-v3 evidence preserves safe-boundary and post-navigation LCP diagnostics plus exactly correlated bootstrap fetch-to-first-byte and response-download phase distributions without replacing the Login LCP or end-to-end RPC gates
- **AND** Login LCP attribution is snapshotted at observer delivery with a nonempty sanitized selector, finite FCP, and structured app/Dashboard/Inventory profiler evidence
- **AND** missing, invalid, non-finite, negative, inverted, unsanitized, or incomplete Web Vitals, realtime-status, or Profiler evidence fails the run
