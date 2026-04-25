## ADDED Requirements

### Requirement: Inventory reserved when item added to session
When an operator adds an inventory item to an active session or customer tab, the system SHALL immediately decrement `stockQty` and write a `StockMovement` record with `reason: "session_reservation"`.

#### Scenario: Stock decremented on add
- **WHEN** operator adds an inventory item with finite stock to a session
- **THEN** `item.stockQty` is decremented by the added quantity immediately, and a `StockMovement` record with reason `"session_reservation"` is persisted

#### Scenario: Unlimited stock items not reserved
- **WHEN** an inventory item has `stockQty = -1` (unlimited/no-track)
- **THEN** no `StockMovement` is created and no decrement occurs

#### Scenario: Out-of-stock blocks add
- **WHEN** operator attempts to add an item whose `stockQty` would go below 0 after reservation
- **THEN** system shows "Insufficient stock" and prevents adding the item

### Requirement: Reservation released when item removed from session
When an operator removes an item from a session or tab BEFORE the bill is issued, the system SHALL restore the reserved stock via a compensating `StockMovement`.

#### Scenario: Stock restored on item removal
- **WHEN** operator removes an inventory item from an open session (not yet billed)
- **THEN** a `StockMovement` with reason `"session_reservation_void"` is written, restoring the stock quantity

#### Scenario: Removing partial quantity restores partial stock
- **WHEN** operator reduces quantity of an item (e.g., from 3 to 1)
- **THEN** a reservation void movement is written for the difference (2 units restored)

### Requirement: Bill finalization converts reservation to sale
At bill issuance, stock movements for the session's items SHALL be reclassified from reservation to sale, with no net change in `stockQty` (since stock was already decremented at add time).

#### Scenario: Reservation converted to sale on checkout
- **WHEN** bill is finalized for a session
- **THEN** the `StockMovement` records for that session's items are updated from `reason: "session_reservation"` to `reason: "sale"`, with no additional `stockQty` change

### Requirement: Existing open sessions reconciled on first deploy
On application startup after this change is deployed, the system SHALL perform a one-time migration that creates `session_reservation` stock movements for items already added to open sessions that pre-date this feature.

#### Scenario: One-time migration runs once
- **WHEN** the app loads for the first time after this feature is deployed
- **THEN** all inventory items currently in open sessions receive a retrospective `session_reservation` movement and the migration flag is set so it never runs again
