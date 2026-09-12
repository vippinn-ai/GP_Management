## ADDED Requirements

### Requirement: Mutation identity is stable
The browser SHALL retain one mutation ID and the server SHALL return its first canonical result without duplicate effects.

#### Scenario: Response is lost
- **WHEN** the identical mutation is replayed
- **THEN** the canonical result returns with no second close, pause, audit, or event

#### Scenario: ID is reused with different intent
- **WHEN** kind, entity, close time, reason, or audit differs
- **THEN** the call fails `mutation_identity_mismatch`

### Requirement: Actor is authenticated
The server SHALL derive actor from `auth.uid()` and reject client actor or compatibility-version authority.

#### Scenario: Client attempts to spoof authority
- **WHEN** an operational payload supplies a user identity or compatibility app-state version, or the caller has no active authorized organization membership
- **THEN** the mutation fails without changing normalized rows, audit logs, events, mutation records, or `app_state`
