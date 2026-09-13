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

#### Scenario: Deferred stock history exceeds one server response page
- **WHEN** Inventory requests complete normalized stock-movement history containing more rows than the PostgREST response cap
- **THEN** the application loads the complete requested history into canonical state through bounded, exact-count, deterministically ordered pages and renders the configured recent subset
- **AND** any missing, drifting, overlapping, out-of-order, timed-out, or incomplete page produces a visible retryable read-only error without presenting partial history as complete
