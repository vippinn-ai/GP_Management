## ADDED Requirements

### Requirement: Authorized roles have read-only activity access
Active admin, manager, and receptionist organization members SHALL be able to read the Activity page, and no Activity UI control SHALL mutate business or evidence data.

#### Scenario: Organization isolation
- **WHEN** an anonymous, inactive, or different-organization caller requests activity
- **THEN** the reader denies the request and returns no cross-organization records

#### Scenario: Historical staff filter
- **WHEN** an actor is inactive or no longer present in the current staff list but has retained activity snapshots
- **THEN** that actor remains available in the server-provided actor filter and can be selected by immutable actor ID

#### Scenario: Deleted historical profile
- **WHEN** a source row contains a valid actor UUID whose profile no longer exists
- **THEN** the activity record and technical details retain that UUID while the display name safely falls back to Unknown user

### Requirement: Activity filters and pagination are server-side
The reader SHALL support bounded keyset pagination plus search, actor, category, action, entity type/ID, date, ISO timestamp, and IST time-of-day filters.

#### Scenario: Equal timestamps
- **WHEN** multiple records share the same timestamp across a page boundary
- **THEN** the `(occurred_at, id)` cursor returns each record exactly once with no gaps or duplicates

#### Scenario: Cross-midnight time range
- **WHEN** a time filter starts later than it ends
- **THEN** the reader interprets it as an IST range crossing midnight

### Requirement: Historical limitations are explicit
Legacy actor identity and timestamps SHALL be preserved from their source records without being represented as server-canonical, while mutable current staff/entity lookup labels SHALL be identified as lookup provenance rather than historical fact.

#### Scenario: Legacy row rendering
- **WHEN** a backfilled row is displayed
- **THEN** the UI marks it Historical and explains both the source-recorded actor/time limitation and the use of current labels where immutable historical labels did not exist
