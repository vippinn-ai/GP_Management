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

### Requirement: Atomic authenticated startup is fail closed
The application SHALL use one authenticated, tenant-derived critical bootstrap result and one shared realtime attempt before assigning identity or enabling writes.

#### Scenario: Active authenticated startup
- **WHEN** a valid session starts the application
- **THEN** the App module load overlaps one shared realtime handshake, the same channel reaches `SUBSCRIBED`, and exactly one no-argument bootstrap RPC returns the actor, organization, critical normalized rows, and compatibility version metadata
- **AND** buffered events for that organization are applied once before safe interaction

#### Scenario: No authenticated session
- **WHEN** local auth contains no session
- **THEN** startup creates no realtime subscription and invokes no bootstrap RPC

#### Scenario: Trust or completeness check fails
- **WHEN** actor, role, organization, RLS, contract, row shape, relationship, bound, byte limit, channel, buffer, or catch-up validation fails
- **THEN** startup removes the attempt channel, clears its tenant identity and buffer, enables no writes, and surfaces blocked or cached-read-only recovery without automatic retry
