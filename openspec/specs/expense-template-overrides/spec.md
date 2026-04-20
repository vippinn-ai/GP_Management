## ADDED Requirements

### Requirement: Override data model
The system SHALL maintain an `ExpenseTemplateOverride` record type in `AppData` with fields: `id`, `templateId`, `monthKey` (format `YYYY-MM`), `amount` (number or null), `skipReason` (optional string), `notes` (optional string), `createdByUserId`, `updatedAt`.

#### Scenario: Override record created
- **WHEN** a user edits or skips a specific month for a template
- **THEN** a new `ExpenseTemplateOverride` record SHALL be written to `AppData.expenseTemplateOverrides` with the correct `templateId` and `monthKey`

#### Scenario: Override record uniqueness
- **WHEN** a user edits a month that already has an override
- **THEN** the existing override record SHALL be updated in place (no duplicates per `templateId + monthKey`)

---

### Requirement: Effective amount resolution
The system SHALL resolve the effective amount for a given template and month using the following precedence: (1) if a skip override exists (`amount === null`), the month is excluded; (2) if an amount override exists, use that amount; (3) if `monthKey < template.startMonth` or template is inactive, the month is excluded; (4) otherwise use `template.amount`.

#### Scenario: Month with amount override
- **WHEN** an override with a numeric amount exists for a template + month
- **THEN** the override amount SHALL be used in all calculations for that month

#### Scenario: Month marked as skipped
- **WHEN** an override with `amount === null` exists for a template + month
- **THEN** that month SHALL contribute ₹0 to normalized expense totals and SHALL be visually shown as skipped

#### Scenario: Month before startMonth
- **WHEN** a month key is earlier than `template.startMonth`
- **THEN** the effective amount SHALL be null (excluded) regardless of any override

---

### Requirement: Cascade delete on template removal
When an `ExpenseTemplate` is deleted, all associated `ExpenseTemplateOverride` records for that template SHALL also be deleted.

#### Scenario: Template deleted with existing overrides
- **WHEN** a user deletes an expense template that has month overrides
- **THEN** all `ExpenseTemplateOverride` records with the matching `templateId` SHALL be removed from `AppData`

---

### Requirement: Update all future months
The system SHALL support applying an override amount to a contiguous range of months from the selected month through December of the same calendar year.

#### Scenario: Propagate override forward
- **WHEN** a user edits a month and chooses "Update this and all future months"
- **THEN** overrides SHALL be created or updated for every month from the selected month through December of the same year with the new amount

#### Scenario: Propagate does not cross year boundary
- **WHEN** "Update this and all future months" is chosen in e.g. October 2026
- **THEN** overrides SHALL be created for Oct, Nov, Dec 2026 only — January 2027 SHALL NOT be affected
