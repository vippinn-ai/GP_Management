## ADDED Requirements

### Requirement: Version conflict error triggers data reload and presents retry
When a save operation fails due to a version conflict ("remote data changed"), the system SHALL automatically reload the latest data and present the operator with a clear "Retry" option to re-execute the failed action, rather than silently dropping it.

#### Scenario: Retry button shown after conflict
- **WHEN** a save operation fails with a version-conflict error
- **THEN** system reloads the latest data AND displays a non-dismissable banner/toast: "Data updated by another device — [Retry]"

#### Scenario: Retry re-executes the failed action
- **WHEN** operator clicks "Retry" after a version conflict
- **THEN** system attempts the same action against the freshly loaded data and proceeds normally if successful

#### Scenario: Retry fails again shows error with dismiss
- **WHEN** a retry attempt also encounters a version conflict
- **THEN** system shows a dismissable error "Could not save — please check the latest data and try again" without an automatic second retry

### Requirement: Version conflict does NOT block UI
After a version conflict and data reload, operators SHALL be able to continue using the rest of the application (view other sessions, navigate) while the retry banner is visible.

#### Scenario: UI remains interactive during retry state
- **WHEN** a version conflict error has occurred and the retry banner is displayed
- **THEN** all other UI elements (other session cards, navigation) are still interactive

### Requirement: Error message is operator-friendly
The visible error text SHALL NOT expose technical internals (version numbers, SQL errors). It SHALL clearly indicate that another device made a change and that retrying is safe.

#### Scenario: Error text is plain language
- **WHEN** a version conflict error is shown
- **THEN** message reads approximately "Another device updated this data. Your changes were not saved. [Retry]" with no technical jargon
