## ADDED Requirements

### Requirement: Sync telemetry captures full-state payload cost before migration
The system SHALL measure current full-state sync cost before replacing the `app_state` architecture.

#### Scenario: App state size is measured before save
- **WHEN** the current app-state save path prepares a remote save
- **THEN** the system records the estimated JSON byte size of the sanitized app data
- **AND** records top-level collection counts for sessions, customer tabs, bills, payments, stock movements, audit logs, inventory items, and combos

#### Scenario: Save timing is measured
- **WHEN** a remote app-state save starts and completes
- **THEN** the system records action label, start time, end time, duration, expected version, resulting version, and whether the save conflicted

#### Scenario: Realtime payload cost is measured
- **WHEN** a realtime app-state snapshot is received
- **THEN** the system records snapshot count and estimated snapshot byte size

### Requirement: Operational actions stop sending full app data after RPC cutover
After an operation is migrated to RPC, the browser SHALL send a compact operation payload instead of the full `AppData` blob.

#### Scenario: Add customer tab item uses compact payload
- **WHEN** RPC operational writes are enabled and staff adds an item to a customer tab
- **THEN** the request payload includes only organization, tab, item, quantity, and user/action metadata needed by the server
- **AND** the request does not include unrelated bills, sessions, customers, expenses, inventory catalog, or audit history

#### Scenario: Start session uses compact payload
- **WHEN** RPC operational writes are enabled and staff starts a session
- **THEN** the request payload includes the selected station, customer details, play mode, combo selections if any, and user/action metadata
- **AND** the server validates station availability and stock before writing rows

### Requirement: Historical reads use bounded queries
The system SHALL avoid loading all historical bills, payments, stock movements, and audit logs for normal screen loads.

#### Scenario: Last 15 business days load quickly
- **WHEN** staff opens bill register, inventory report, analytics, or customer receivables
- **THEN** the default query covers the last 15 business days or the screen's selected bounded range
- **AND** older rows are not loaded unless staff searches or paginates

#### Scenario: Older history remains searchable
- **WHEN** staff searches for records older than 15 business days
- **THEN** the system queries normalized historical tables with filters and pagination
- **AND** results may take a few seconds but do not require downloading the full business history

### Requirement: Realtime subscriptions are screen-scoped
The system SHALL not use one full-state realtime subscription as the primary synchronization mechanism after normalized realtime cutover.

#### Scenario: Dashboard subscribes to live operational data
- **WHEN** staff is on the dashboard
- **THEN** the client subscribes only to live sessions, open customer tabs, stations, and compact operational events needed by the dashboard

#### Scenario: Reports do not use broad realtime
- **WHEN** staff is on reports or historical bill screens
- **THEN** the client does not subscribe to all historical row changes by default
- **AND** staff can refresh or search to load the latest report data
