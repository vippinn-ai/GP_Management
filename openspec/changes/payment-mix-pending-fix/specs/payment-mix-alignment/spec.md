## ADDED Requirements

### Requirement: Payment Mix totals equal Gross Revenue
The system's Payment Mix breakdown (Cash total and UPI total displayed in the analytics report) SHALL account for all payments that contribute to Gross Revenue, including upfront payments collected at checkout on deferred (pending) bills — not only payments on fully-settled (issued) bills.

#### Scenario: Deferred bill with upfront payment is reflected in Payment Mix
- **WHEN** a deferred bill exists in the date range with `status === "pending"`, `amountPaid = X` (upfront cash or UPI collected at checkout), and `amountDue > 0`
- **THEN** the Payment Mix Cash or UPI total includes the X amount, and `Cash + UPI == Gross Revenue`

#### Scenario: Fully deferred bill (no upfront) does not affect Payment Mix
- **WHEN** a deferred bill exists with `amountPaid = 0` (nothing collected upfront)
- **THEN** the Payment Mix is unchanged and `deferredCollected = 0` for that bill, so `Cash + UPI == Gross Revenue` still holds

#### Scenario: Settled deferred bill does not cause double-counting
- **WHEN** a previously-pending bill is fully settled and transitions to `status === "issued"`
- **THEN** it is counted via the issued-bills path only; no double-counting occurs in Payment Mix

#### Scenario: All-cash issued bills — Payment Mix unchanged
- **WHEN** all bills in the date range are fully-paid cash bills with `status === "issued"` and no pending bills exist
- **THEN** Payment Mix totals are the same as before this change (no regression)

#### Scenario: Payment Mix displayed on reports panel
- **WHEN** operator views the analytics report for any date range
- **THEN** the "Payment Mix" row shows `Cash ₹X · UPI ₹Y` where `X + Y == Gross Revenue` for that range
