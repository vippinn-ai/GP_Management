## ADDED Requirements

### Requirement: Normalized financial reads fail closed
When normalized mode is enabled, startup, bill register, reports, inventory reports, customer search, and financial recovery SHALL read normalized tables and SHALL NOT display cached `app_state` financial data after a read failure.

#### Scenario: Report read fails
- **WHEN** a normalized report request fails or is still loading
- **THEN** the report screen shows a retryable unavailable/loading state
- **AND** it does not render cached revenue, payment, expense, or profit figures

#### Scenario: Bill register read fails
- **WHEN** normalized bill history cannot be loaded
- **THEN** bill and receivable actions are hidden behind a retry action
- **AND** stale bills cannot be selected, settled, replaced, voided, or printed

### Requirement: Normalized realtime merges compact financial changes
Compact operational events SHALL hydrate changed rows by ID and merge them into existing normalized collections without deleting unrelated history.

#### Scenario: Financial event changes customer, stock movement, and audit
- **WHEN** another browser commits a financial mutation
- **THEN** the receiving browser loads the changed customer, stock movement, and audit rows by ID
- **AND** retains all unchanged rows already present locally

### Requirement: Normalized mode retains operational maintenance actions
Manual pause edit/delete and post-hop detach audit actions SHALL use purpose-built normalized RPCs while generic full-state saves remain blocked.

#### Scenario: Pause log is edited after normalized bootstrap
- **WHEN** an authorized user edits a pause interval
- **THEN** the pause row and audit/event rows commit atomically without reading or writing `app_state`

