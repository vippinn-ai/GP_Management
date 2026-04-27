## ADDED Requirements

### Requirement: Discount-driven zero bills are issuable
When all bill lines have a positive `unitPrice` but applied discounts (line-level, bill-level, or LTP-win auto-discount) reduce the rounded total to ₹0, the system SHALL allow the bill to be issued. The "Issue Bill" / "Issue Replacement Bill" button SHALL remain enabled, and `finalizeCheckout` SHALL proceed without an error alert.

#### Scenario: LTP win with no consumables issues a ₹0 bill
- **WHEN** operator checks out an LTP-eligible solo session with outcome "won" and there are no consumable items on the bill
- **THEN** the session charge line is fully discounted, total = ₹0, and the "Issue Bill" button is enabled and issues the bill successfully

#### Scenario: Full manual line discount issues a ₹0 bill
- **WHEN** operator applies a line discount equal to the full line subtotal on every line of a session or tab bill
- **THEN** total = ₹0 and the bill is issuable (button enabled, no blocking alert)

#### Scenario: Full bill-level discount issues a ₹0 bill
- **WHEN** operator applies a bill-level discount whose amount equals the net total after line discounts
- **THEN** total = ₹0 and the bill is issuable

#### Scenario: Replacement bill with discount-driven zero total is issuable
- **WHEN** operator opens a bill replacement and the replacement lines + discounts resolve to ₹0 (subtotal > 0)
- **THEN** the "Issue Replacement Bill" button is enabled and replacement proceeds

### Requirement: Zero-total bill issues with no payment records
When a bill is issued with total = ₹0 (discount-driven), the system SHALL record `amountPaid = 0`, `amountDue = 0`, `status = "issued"`, and SHALL NOT create any payment rows in the payments table for that bill.

#### Scenario: Cash mode zero-total bill has no payment record
- **WHEN** operator issues a ₹0 bill with payment mode "cash"
- **THEN** the bill's `amountPaid = 0`, `amountDue = 0`, `status = "issued"`, and no payment record is created

#### Scenario: UPI mode zero-total bill has no payment record
- **WHEN** operator issues a ₹0 bill with payment mode "upi"
- **THEN** no payment record is created

#### Scenario: Split mode zero-total bill has no payment records
- **WHEN** operator issues a ₹0 bill with payment mode "split" (both cash and UPI amounts are 0)
- **THEN** no payment records are created

### Requirement: Bill replacement defaults to cash when original was deferred
When opening a bill replacement for an original bill whose `paymentMode` is `"deferred"`, the replacement checkout state SHALL initialize `paymentMode` to `"cash"`.

#### Scenario: Deferred original replaced with cash default
- **WHEN** operator clicks "Replace" on a fully-settled deferred bill (status = "issued", paymentMode = "deferred")
- **THEN** the replacement checkout modal opens with payment mode defaulted to "cash"

#### Scenario: Non-deferred original preserves payment mode
- **WHEN** operator clicks "Replace" on a bill whose paymentMode is "cash", "upi", or "split"
- **THEN** the replacement checkout modal opens with the same payment mode as the original
