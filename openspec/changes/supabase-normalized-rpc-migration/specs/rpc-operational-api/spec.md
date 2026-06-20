## ADDED Requirements

### Requirement: Operational writes are executed through server-side RPC
After RPC cutover for an operation, the browser SHALL call a Supabase RPC function instead of writing the full application state.

#### Scenario: Start session RPC validates station conflict
- **WHEN** two devices attempt to start the same station
- **THEN** the RPC allows only one open session for that station
- **AND** the losing request receives an operator-friendly conflict response

#### Scenario: Add inventory item RPC validates stock
- **WHEN** two devices attempt to reserve the last available stock
- **THEN** the RPC validates available stock inside the database transaction
- **AND** only requests that fit available stock are committed

### Requirement: RPC functions write audit and event rows atomically
Business mutations SHALL write domain rows, audit rows, and operational event rows in the same short transaction.

#### Scenario: Customer tab item added
- **WHEN** staff adds an item to a customer tab through RPC
- **THEN** the customer tab item row is inserted or updated
- **AND** an audit row is written
- **AND** a compact operational event row is written
- **AND** all three changes commit or roll back together

### Requirement: Financial writes remain blocking and server-confirmed
Checkout and money-changing operations SHALL remain blocking and server-confirmed throughout migration.

#### Scenario: Checkout waits for pending operational sync
- **WHEN** a session or customer tab has unsynced operational changes
- **THEN** checkout is disabled or waits until those changes are confirmed by the server

#### Scenario: Bill issue returns final server rows
- **WHEN** checkout succeeds through RPC
- **THEN** the server returns the final bill, bill lines, payments, stock movements, and audit/event rows needed by the UI
- **AND** the browser does not calculate a conflicting final persisted bill independently

### Requirement: RPC responses support smooth UI updates
RPC functions SHALL return only the affected rows and metadata needed to update the current screen.

#### Scenario: Pause session response is small
- **WHEN** staff pauses a session
- **THEN** the RPC response includes the changed session status, pause log, audit/event metadata, and server time
- **AND** does not include unrelated customers, bills, inventory catalog, or historical data

#### Scenario: Apply consumables combo response is small
- **WHEN** staff applies a consumables combo to a customer tab
- **THEN** the RPC response includes the changed tab combo application, included tab item rows, stock reservation/update information if needed, audit/event metadata, and server time
- **AND** does not include unrelated application state

### Requirement: RPC errors are operator-friendly
RPC failures SHALL return stable error codes and plain-language messages that the UI can show safely.

#### Scenario: Station occupied conflict
- **WHEN** a station is already occupied
- **THEN** the RPC returns a conflict code such as `station_occupied`
- **AND** the UI can show a message like "This station was started on another device."

#### Scenario: Insufficient stock conflict
- **WHEN** requested stock is no longer available
- **THEN** the RPC returns a conflict code such as `insufficient_stock`
- **AND** includes the item name and available quantity when safe to show

### Requirement: RPCs preserve existing business behavior
Migrated RPC operations SHALL match existing app behavior unless a separate product change is approved.

#### Scenario: Existing combo billing behavior remains unchanged
- **WHEN** a game combo or consumables combo is applied after RPC migration
- **THEN** package lines, zero-price included detail lines, stock units, and snapshots match current behavior

#### Scenario: Existing cigarette pack behavior remains unchanged
- **WHEN** cigarette pack or single-item sale is processed after RPC migration
- **THEN** stock deduction and bill lines match current behavior

#### Scenario: Pending dues remain visible
- **WHEN** a customer with pending bills starts a session or opens a customer tab after RPC migration
- **THEN** pending dues still appear in live bill context according to current behavior
