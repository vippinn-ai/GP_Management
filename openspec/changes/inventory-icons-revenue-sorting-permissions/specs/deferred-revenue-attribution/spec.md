## ADDED Requirements

### Requirement: Upfront-collected amount from deferred bills counted in gross revenue
The system SHALL include the `amountPaid` of deferred/pending bills (where a partial or full upfront payment was collected at billing time) in the gross revenue figure for the date the bill was issued, rather than waiting until the bill is fully settled.

#### Scenario: Deferred bill with upfront payment contributes to revenue
- **WHEN** a bill has `paymentMode: "deferred"`, `status: "pending"`, and `amountPaid > 0`, and its `issuedAt` date falls within the selected report period
- **THEN** `amountPaid` is included in the gross revenue total for that period

#### Scenario: Fully-deferred bill with no upfront payment contributes zero
- **WHEN** a deferred bill has `amountPaid = 0`
- **THEN** it contributes ₹0 to gross revenue (no change from previous behaviour)

#### Scenario: Fully-paid issued bills unaffected
- **WHEN** a bill has `status: "issued"` and `paymentMode` is cash, upi, or split
- **THEN** the full `bill.total` continues to be counted in gross revenue as before

### Requirement: Deferred outstanding shown as a separate report metric
The system SHALL display a "Deferred Outstanding" KPI in the reports view showing the total `amountDue` still owed across all pending bills whose `issuedAt` date falls in the selected report period.

#### Scenario: Deferred outstanding shown when non-zero
- **WHEN** there are one or more pending bills with `amountDue > 0` in the selected period
- **THEN** a "Deferred Outstanding" KPI card is visible showing the total amount still owed

#### Scenario: Deferred outstanding hidden when zero
- **WHEN** there are no pending bills with unpaid amounts in the selected period
- **THEN** the "Deferred Outstanding" KPI is not shown (to avoid cluttering the report on clean days)

### Requirement: Dashboard active sessions sorted first
The system SHALL display station cards with an active (running or paused) session before vacant station cards in the live dashboard grid, without adding any visual section headers or separators.

#### Scenario: Active sessions appear before vacant stations
- **WHEN** the live dashboard is rendered with a mix of active and vacant stations
- **THEN** all stations with a live session (status active or paused) appear first; vacant stations appear after

#### Scenario: Sort within each group preserves original order
- **WHEN** multiple stations have active sessions
- **THEN** they retain their relative order from the stations configuration (stable sort)

#### Scenario: All-vacant or all-active dashboards unaffected
- **WHEN** all stations are vacant or all stations are active
- **THEN** the order is unchanged from the current configuration order

### Requirement: Customer name and phone editable by all staff roles
The system SHALL allow users with any role (admin, manager, receptionist) to add or update the customer name and phone number at every touchpoint: session start, session manage modal, and checkout.

#### Scenario: Receptionist can edit customer details during session
- **WHEN** a receptionist opens the session manage modal and clicks "Edit Customer Details"
- **THEN** the customer name and phone fields are editable and changes can be saved

#### Scenario: Manager can edit customer details at checkout
- **WHEN** a manager is on the checkout screen
- **THEN** the customer name and phone fields in the checkout form are enabled (not disabled)

#### Scenario: Customer fields always enabled on session start
- **WHEN** any logged-in user opens the start-session dialog
- **THEN** the customer name and phone fields are always enabled regardless of role
