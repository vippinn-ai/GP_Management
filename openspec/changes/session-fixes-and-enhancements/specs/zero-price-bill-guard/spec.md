## ADDED Requirements

### Requirement: Bill issuance blocked when total is zero or negative
The system SHALL prevent finalizing a bill when the computed `total` (after all discounts and rounding) is ≤ 0.

#### Scenario: Zero total blocks checkout
- **WHEN** operator attempts to issue a bill and `preview.total <= 0`
- **THEN** system displays a blocking error modal "Bill total is ₹0 — add items or remove discounts before issuing" and does NOT proceed with `finalizeCheckout`

#### Scenario: Issue bill button disabled on zero total
- **WHEN** the bill preview computes a total of ≤ 0
- **THEN** the "Issue Bill" button is visually disabled and shows a tooltip explaining the zero-total reason

#### Scenario: Normal bill unaffected
- **WHEN** bill preview total is > 0
- **THEN** checkout proceeds normally with no additional prompts

### Requirement: Consumable tab price validation
When items are added to a customer tab or session, the system SHALL warn if any item has a unit price of ₹0, as this is a common root cause of zero-price bills.

#### Scenario: Zero-price item warning on add
- **WHEN** operator adds an inventory item whose `salePrice` is 0
- **THEN** system shows an inline warning "This item has a ₹0 price — confirm or update in inventory" but still allows adding

#### Scenario: Items with valid prices show no warning
- **WHEN** operator adds an inventory item with `salePrice > 0`
- **THEN** no warning is shown

### Requirement: Audit log query for historical zero-price bills
The system SHALL include a documented, runnable Supabase SQL query (in source comments or a developer note) that surfaces all past bills with `total = 0` for root-cause investigation.

#### Scenario: Query is available to developers
- **WHEN** a developer needs to audit zero-price bills in production
- **THEN** a ready-to-run SQL query is documented in the source (e.g., in a code comment near the bill finalization logic) that filters `bills` by `total = 0` with relevant columns (session ID, timestamp, items)
