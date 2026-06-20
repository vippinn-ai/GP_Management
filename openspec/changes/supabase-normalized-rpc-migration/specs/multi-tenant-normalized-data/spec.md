## ADDED Requirements

### Requirement: Business data is tenant-scoped
All normalized business-domain rows SHALL be scoped by `organization_id`.

#### Scenario: Session belongs to one organization
- **WHEN** a session row is created
- **THEN** it includes exactly one `organization_id`
- **AND** users outside that organization cannot read or mutate it

#### Scenario: Bill belongs to one organization
- **WHEN** a bill row and bill line rows are created
- **THEN** each row includes the same `organization_id`
- **AND** bill lines cannot be queried across organizations by an authenticated user

### Requirement: RLS enforces tenant membership
Every normalized tenant table SHALL have RLS enabled and policies that require active organization membership.

#### Scenario: Active member can read organization rows
- **GIVEN** a user is an active member of an organization
- **WHEN** the user queries rows for that organization
- **THEN** rows are visible according to that user's role and tab permissions

#### Scenario: Non-member cannot read organization rows
- **GIVEN** a user is not an active member of an organization
- **WHEN** the user queries rows for that organization
- **THEN** the database returns no rows

#### Scenario: Inactive member cannot mutate organization rows
- **GIVEN** a user's organization membership is inactive
- **WHEN** the user attempts to insert, update, or delete organization rows
- **THEN** the database rejects the mutation

### Requirement: Existing IDs remain stable during first migration
The first normalized migration SHALL preserve existing app-generated string IDs.

#### Scenario: Existing bill keeps ID
- **WHEN** a bill is migrated from `app_state` to normalized tables
- **THEN** the normalized `bills.id` equals the original bill ID
- **AND** all bill lines, payments, sessions, and audit rows continue to reference the same logical bill

#### Scenario: Existing inventory item keeps ID
- **WHEN** inventory items and sale variants are migrated
- **THEN** source item IDs and sale variant IDs remain stable for historical bill lines and stock movements

### Requirement: Historical data remains queryable after archive/inactive changes
Archived inventory, inactive combos, closed sessions, voided bills, and old customers SHALL remain available for historical reports and bill/receipt lookup.

#### Scenario: Archived inventory appears in historical report
- **GIVEN** an inventory item is archived after it had stock movements
- **WHEN** staff opens an inventory report for a date range where the item moved
- **THEN** the item appears with its archived status and historical movement totals

#### Scenario: Old combo snapshot remains intact
- **GIVEN** a combo definition is changed after a session or tab used it
- **WHEN** the related bill or receipt is viewed
- **THEN** the stored combo application snapshot is displayed rather than the current combo definition

### Requirement: Fast history and deep history use different access patterns
The normalized schema SHALL optimize current operational data and recent history separately from deep history searches.

#### Scenario: Recent bills use indexed date range
- **WHEN** staff opens the default bill register
- **THEN** the query uses `organization_id` plus issued date ordering/filtering
- **AND** returns a bounded page of recent rows

#### Scenario: Deep bill search uses cursor pagination
- **WHEN** staff searches older bills
- **THEN** the query uses filters and a cursor based on the sort columns
- **AND** avoids deep offset scans
