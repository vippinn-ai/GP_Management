## ADDED Requirements

### Requirement: Backend startup can skip full app-state data
The system SHALL support a feature-flagged startup path that does not download `public.app_state.data`.

#### Scenario: Normalized bootstrap is enabled
- **WHEN** backend mode is active and normalized bootstrap is enabled
- **THEN** startup loads business data from normalized tables and lightweight app-state metadata
- **AND** startup does not select or download the full `app_state.data` JSON blob

#### Scenario: Normalized bootstrap is disabled
- **WHEN** normalized bootstrap is disabled
- **THEN** startup uses the existing `app_state` snapshot path for rollback compatibility

### Requirement: Partial normalized startup data cannot overwrite app-state
The system SHALL prevent partial normalized bootstrap data from being saved as the full compatibility snapshot.

#### Scenario: Generic app-state save is attempted after normalized bootstrap
- **WHEN** the current browser data was loaded by normalized bootstrap
- **AND** a generic full-state `saveAppData` path is reached
- **THEN** the save is blocked with an operator-safe error
- **AND** operational and financial RPC writes remain available

### Requirement: Startup loads only bounded operational data
The normalized bootstrap SHALL load only the data required for immediate operation and defer large history to screen-specific queries.

#### Scenario: Historical arrays are large
- **WHEN** the business has old bills, payments, stock movements, and audit logs
- **THEN** startup does not download all historical rows
- **AND** bill register, reports, inventory report, and customer search use normalized paginated or filtered loaders

### Requirement: Startup telemetry proves egress reduction
The system SHALL expose startup telemetry that shows whether full app-state data was skipped.

#### Scenario: Staff verifies staging startup
- **WHEN** staging is hard-refreshed after normalized bootstrap deployment
- **THEN** browser telemetry shows `source = normalized_bootstrap`
- **AND** shows `skippedFullAppStateData = true`
- **AND** records startup slice durations and approximate payload sizes
