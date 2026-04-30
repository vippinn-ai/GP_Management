## ADDED Requirements

### Requirement: Hopped session can continue as a consumables tab
After a game hop, the system SHALL let staff continue the same customer either into another gaming session or into a consumables tab from the existing post-hop modal, with gaming selected by default.

#### Scenario: Gaming continuation remains default
- **WHEN** staff confirms a game hop
- **THEN** the continuation modal opens with gaming selected by default and the hopped customer's details prefilled

#### Scenario: Staff chooses consumables continuation
- **WHEN** staff switches the post-hop continuation mode to consumables and confirms
- **THEN** the system opens or selects the matching customer tab using the hopped customer's details and routes staff to the consumables workflow

### Requirement: Customer-tab checkout can include previous hopped game sessions
When checking out a customer tab, the system SHALL search for matching unbilled hopped game sessions and SHALL display them as selectable, preselected previous sessions for inclusion in the customer-tab bill.

#### Scenario: Matching hopped sessions appear during customer-tab checkout
- **WHEN** staff begins checkout for a customer tab whose customer matches one or more unbilled hopped game sessions
- **THEN** the checkout modal shows those previous game sessions selected for inclusion

#### Scenario: Selected hopped sessions are included in tab bill
- **WHEN** staff issues a customer-tab bill with previous hopped sessions selected
- **THEN** the bill includes lines from the selected hopped sessions and the current customer tab, and each selected hopped session is marked billed with the new bill ID

#### Scenario: Deselected hopped sessions remain unbilled
- **WHEN** staff deselects a previous hopped session before issuing a customer-tab bill
- **THEN** that previous session is excluded from the bill and remains unbilled with `closeDisposition = "hopped"` for a later checkout

### Requirement: Previous session waiver uses existing discount audit trail
When staff wants to waive or discount a previous hopped session during combined checkout, the system SHALL require them to include the session and use the existing checkout discount controls so the discount reason is captured.

#### Scenario: Previous session excluded rather than discounted
- **WHEN** staff deselects a previous hopped session during checkout
- **THEN** the system treats the session as bill-later, not as discounted or waived
