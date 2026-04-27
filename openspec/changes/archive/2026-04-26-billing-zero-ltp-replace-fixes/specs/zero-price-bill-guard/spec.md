## MODIFIED Requirements

### Requirement: Bill issuance blocked when bill has no chargeable items
The system SHALL prevent finalizing a bill when `subtotal` (sum of `quantity × unitPrice` across all lines, before any discounts) is ≤ 0. A discount-driven zero total (subtotal > 0, total = 0 after discounts) is explicitly NOT blocked by this guard.

#### Scenario: Empty bill blocks checkout
- **WHEN** operator attempts to issue a bill with no lines (or all lines have unitPrice = 0)
- **THEN** system displays a blocking error "Bill total is ₹0 — add items or remove any full discounts before issuing." and does NOT proceed with `finalizeCheckout`

#### Scenario: Issue bill button disabled when subtotal is zero
- **WHEN** the bill preview computes a subtotal of ≤ 0 (no items or all items at ₹0 price)
- **THEN** the "Issue Bill" button is visually disabled

#### Scenario: Discount-driven zero total is NOT blocked
- **WHEN** bill lines have positive prices and applied discounts bring total to ₹0 (subtotal > 0)
- **THEN** the "Issue Bill" button remains enabled and checkout proceeds normally

#### Scenario: Normal bill unaffected
- **WHEN** bill preview total is > 0
- **THEN** checkout proceeds normally with no additional prompts
