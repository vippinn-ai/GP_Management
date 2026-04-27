## ADDED Requirements

### Requirement: Session can be closed without billing ("game hop")
A session SHALL be closeable with `closeDisposition = "hopped"` — the station is released immediately, no bill is created, and all session data (charges, items, customer details, timing) is preserved for later combined billing.

#### Scenario: Staff triggers game hop from checkout modal
- **WHEN** staff opens the checkout modal for an active session and selects the "Close for game hop — bill later" option
- **THEN** the session is closed with `status = "closed"`, `closeDisposition = "hopped"`, `endedAt` set to the effective close time, no bill is created, the station is released, and the checkout modal closes

#### Scenario: Hopped session releases the station
- **WHEN** a session is closed via game hop
- **THEN** the station's active session slot is freed and can be used to start a new session immediately

#### Scenario: Customer details preserved on hopped session
- **WHEN** a session is closed via game hop
- **THEN** the session retains `customerName`, `customerPhone`, and `customerId` exactly as entered

### Requirement: Start-session form pre-fills customer from recent hop
When starting a new session and there is at least one `closeDisposition === "hopped"` session without a `closedBillId`, the start-session form SHALL pre-fill `customerName`, `customerPhone` from the most recently hopped session (by `endedAt` descending).

#### Scenario: Customer details auto-fill after hop
- **WHEN** staff opens the start-session dialog and a hopped unbilled session exists
- **THEN** the customer name and phone fields are pre-filled with that session's customer data; staff may override

#### Scenario: No hop sessions — start-session form is blank
- **WHEN** there are no hopped unbilled sessions
- **THEN** the start-session form behaves exactly as before (no pre-fill)

### Requirement: Hopped sessions offered for inclusion at checkout
When the checkout modal opens for any active session, the system SHALL search for sessions with `closeDisposition === "hopped"` and no `closedBillId` that match the current customer (by phone number or by name case-insensitively), and SHALL display them as a selectable list for staff.

#### Scenario: Matching hopped sessions shown at checkout
- **WHEN** staff opens the checkout modal for a session and there are hopped unbilled sessions matching the customer's phone or name
- **THEN** the checkout modal shows a section "Previous unbilled sessions" listing each hopped session (station name, duration, approximate charge) with a checkbox pre-selected

#### Scenario: Staff deselects a hopped session
- **WHEN** staff unchecks a hopped session from the list
- **THEN** that session's charges are excluded from the combined bill preview

#### Scenario: No matching hopped sessions — checkout modal unchanged
- **WHEN** no hopped sessions match the current customer
- **THEN** the checkout modal appears exactly as before with no additional section

### Requirement: Combined bill includes all selected hopped sessions
When staff issues a bill with one or more hopped sessions selected, the bill SHALL include line items from all selected hopped sessions (session charge + session items for each) as well as the current session's lines.

#### Scenario: Combined bill shows all session lines
- **WHEN** operator issues a bill that includes two hopped sessions plus the current session
- **THEN** the bill has session charge and item lines from session 1, session 2, and the current session, all clearly labeled by session/station name

#### Scenario: Bill preview reflects combined total
- **WHEN** hopped sessions are selected in the checkout modal
- **THEN** the bill preview total updates in real time to reflect the combined amount before issuing

#### Scenario: Discounts and round-off apply to the combined total
- **WHEN** an operator applies a bill-level discount or enables round-off on a combined bill
- **THEN** the discount and round-off are computed on the combined subtotal across all sessions

### Requirement: Hopped sessions marked billed after combined billing
After a combined bill is issued, each hopped session that was included SHALL be updated to `closeDisposition = "billed"` and `closedBillId = <new bill ID>`.

#### Scenario: Hopped sessions closed after combined bill issued
- **WHEN** a combined bill is issued including two hopped sessions
- **THEN** both hopped sessions have `closedBillId` set to the new bill ID and `closeDisposition = "billed"`

#### Scenario: Hopped sessions no longer appear in future checkout suggestions
- **WHEN** hopped sessions have been billed (closedBillId is set)
- **THEN** they are no longer shown in the "Previous unbilled sessions" section of any checkout modal
