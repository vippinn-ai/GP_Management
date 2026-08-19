## ADDED Requirements

### Requirement: Checkout locks all financial source rows deterministically
Checkout SHALL serialize the mutation record, source sessions, source tabs, referenced bills, and affected inventory in a stable order and revalidate state after locking.

#### Scenario: Two devices bill the same session
- **WHEN** two checkout calls race for one session
- **THEN** one commits and the other receives a stable billability conflict
- **AND** there is one bill and one set of effects

#### Scenario: Limited stock is sold concurrently
- **WHEN** competing checkouts require the remaining stock
- **THEN** locked current stock and other open reservations are considered
- **AND** committed stock cannot become negative or undercut remaining reservations

### Requirement: Server source snapshots govern checkout
For non-replacement checkout, server session/tab items, combo applications, pauses, pricing snapshots, timing, LTP state, and inventory metadata SHALL determine the allowed bill lines and stock deltas.

#### Scenario: Caller submits a cheaper self-consistent bill
- **WHEN** bill quantities, unit prices, combo rows, timed charge, pack size, or stock units differ from locked source rows
- **THEN** the entire mutation is rejected without financial effects

#### Scenario: Adjustment conflicts with checkout
- **WHEN** settlement, replacement, void/refund, reject, hop, or inventory work races with checkout
- **THEN** locked expectations prevent over-settlement, double billing, stale success, and lost stock

