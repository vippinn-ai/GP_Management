## ADDED Requirements

### Requirement: Financial mutation identity is stable and replayable
The browser SHALL retain one mutation ID across ambiguous transport failures, and the server SHALL return the first canonical committed result for the same authenticated actor, operation, and entity without duplicating effects.

#### Scenario: Checkout response is lost
- **WHEN** the database commits but the browser loses the response
- **THEN** mutation-status reconciliation or replay returns the committed canonical bill
- **AND** no second bill, payment, stock movement, or audit is created

#### Scenario: Mutation ID is reused for another entity
- **WHEN** a caller reuses a mutation ID for a different operation or entity
- **THEN** the server rejects it with `mutation_payload_mismatch`

### Requirement: Receipts use canonical committed rows
The UI SHALL create a receipt only from the canonical bill and payments returned by the committed mutation.

#### Scenario: Client request differs from canonical actor data
- **WHEN** the server stamps authenticated actor fields
- **THEN** the displayed and exported receipt is based on the server-confirmed bill

