## ADDED Requirements

### Requirement: 12-month grid per template
The system SHALL display a 12-month grid for each expense template in the Reports panel, showing each month's effective amount (or "Skipped" label if skipped).

#### Scenario: Grid shows all months
- **WHEN** a user expands a template's detail view
- **THEN** all 12 months of the selected year SHALL be displayed with their effective amounts

#### Scenario: Override month displayed distinctly
- **WHEN** a month has an amount override different from the template base amount
- **THEN** the overridden amount SHALL be shown with a visual indicator distinguishing it from the base amount

#### Scenario: Skipped month displayed
- **WHEN** a month has a skip override (`amount === null`)
- **THEN** the month SHALL show a "Skipped" label along with the skip reason if one was provided

---

### Requirement: Year navigation in month grid
The system SHALL allow users to switch between calendar years in the month grid to view or edit overrides for any year.

#### Scenario: Navigate to previous year
- **WHEN** a user clicks the previous-year control in the month grid
- **THEN** the grid SHALL refresh to show the 12 months of the prior calendar year

#### Scenario: Navigate to next year
- **WHEN** a user clicks the next-year control in the month grid
- **THEN** the grid SHALL refresh to show the 12 months of the following calendar year

---

### Requirement: Inline month edit action
The system SHALL allow authorized users to edit the amount for any individual month directly from the month grid.

#### Scenario: Edit single month
- **WHEN** a user clicks the edit action on a month cell
- **THEN** an edit dialog SHALL appear pre-filled with the current effective amount, and upon save the user SHALL be prompted to apply the change to "Just this month" or "This and all future months (through December)"

#### Scenario: Edit dialog validation
- **WHEN** a user attempts to save an edit with a negative or non-numeric amount
- **THEN** the save SHALL be blocked and a validation message SHALL be shown

---

### Requirement: Per-month skip action with reason
The system SHALL allow authorized users to mark a specific month as skipped with an optional reason.

#### Scenario: Skip a month
- **WHEN** a user clicks the skip action on a month cell and confirms
- **THEN** an `ExpenseTemplateOverride` with `amount: null` SHALL be saved and the month SHALL display as "Skipped" in the grid

#### Scenario: Skip with reason
- **WHEN** a user enters a skip reason before confirming the skip
- **THEN** the reason SHALL be stored in `skipReason` and displayed in the month cell tooltip or label

#### Scenario: Restore a skipped month
- **WHEN** a user clicks "Restore" on a skipped month
- **THEN** the skip override SHALL be deleted and the month SHALL revert to the template's base amount
