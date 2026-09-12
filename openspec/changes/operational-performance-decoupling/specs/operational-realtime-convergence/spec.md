## ADDED Requirements

### Requirement: Targeted canonical hydration converges
Origin and observers SHALL hydrate compact changed normalized IDs without a full compatibility snapshot.

#### Scenario: Delivery order reverses
- **WHEN** realtime, RPC response, and hydration complete in any order
- **THEN** all browsers converge to the canonical closed entity and cannot resurrect it

#### Scenario: Hydration fails after commit
- **WHEN** the transaction committed but hydration failed
- **THEN** the same mutation remains explicitly recoverable without automatic resubmission

### Requirement: Startup catches concurrent events
The application SHALL subscribe and catch up compact events before enabling writes after critical bootstrap.

#### Scenario: Mutation arrives during startup
- **WHEN** a compact operational event arrives after subscription is confirmed but before the critical snapshot is ready
- **THEN** the application buffers and applies that event before enabling writes, without reading or reapplying `app_state.data`
