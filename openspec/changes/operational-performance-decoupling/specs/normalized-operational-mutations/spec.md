## ADDED Requirements

### Requirement: Critical lifecycle closes are normalized-only
Hop session, reject session, and reject customer tab v2 SHALL commit only normalized rows and SHALL NOT read, lock, patch, or update `app_state`.

#### Scenario: Production-sized compatibility state exists
- **WHEN** an authorized user executes a target v2 command
- **THEN** latency is independent of compatibility-document size
- **AND** `app_state` data, version, timestamp, and updater remain unchanged

### Requirement: Canonical state is preserved
The server SHALL patch only legal closure, pause, continuation-release, audit, mutation, and event fields.

#### Scenario: Browser snapshot is stale
- **WHEN** canonical customer, items, combos, timing, or pricing differs
- **THEN** canonical values remain unchanged except for the legal terminal transition

### Requirement: Continuations have one consumer
Game and tab continuation creation SHALL lock and validate every hopped source and advance UI only after confirmation.

#### Scenario: Two consumers claim one hop
- **WHEN** requests race
- **THEN** exactly one commits and the other returns a stable conflict

