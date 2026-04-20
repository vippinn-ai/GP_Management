## ADDED Requirements

### Requirement: Backfill prompt on mid-year template creation
When a user creates a new expense template and the current month is not January, the system SHALL present a prompt asking whether to apply the template from January of the current year or from the current month.

#### Scenario: Template created in non-January month
- **WHEN** a user saves a new `ExpenseTemplate` and the current calendar month is February through December
- **THEN** a prompt SHALL appear with two options: "From January [year]" and "From [current month name] [year]"

#### Scenario: Template created in January
- **WHEN** a user saves a new `ExpenseTemplate` and the current month is January
- **THEN** no backfill prompt SHALL appear; `startMonth` SHALL be set to the current month automatically

---

### Requirement: Backfill sets startMonth to January
When the user chooses to backfill, the system SHALL set `template.startMonth` to `YYYY-01` of the current year.

#### Scenario: User selects backfill
- **WHEN** a user chooses "From January [year]" in the backfill prompt
- **THEN** `template.startMonth` SHALL be set to `[current year]-01`
- **AND** the template SHALL be visible and active for all months January through December in the month grid

---

### Requirement: No-backfill sets startMonth to current month
When the user declines backfill, `startMonth` SHALL be set to the current `YYYY-MM`.

#### Scenario: User selects current month
- **WHEN** a user chooses "From [current month name] [year]" in the backfill prompt
- **THEN** `template.startMonth` SHALL be set to the current `YYYY-MM`
- **AND** months before the current month SHALL show as excluded in the month grid for that year
