## ADDED Requirements

### Requirement: View pause intervals in session modal
The session details modal SHALL display all pause log entries for the session as a list, showing `pausedAt` and `resumedAt` (or "Active" if the pause is still open) for each entry.

#### Scenario: View pause history
- **WHEN** operator opens the session details modal for a session that has been paused at least once
- **THEN** system displays each pause log entry with formatted datetime for both `pausedAt` and `resumedAt`

#### Scenario: Open pause entry shown
- **WHEN** a session is currently paused (no `resumedAt` on the latest log entry)
- **THEN** the latest entry shows `resumedAt` as "Active" or equivalent indicator

### Requirement: Edit individual pause timestamp
The system SHALL allow an operator to edit the `pausedAt` or `resumedAt` timestamp of any existing pause log entry via a datetime picker in the session modal.

#### Scenario: Edit pausedAt
- **WHEN** operator clicks the edit icon on a pause log entry and changes the `pausedAt` datetime
- **THEN** system validates that the new `pausedAt` is not before the session's `startTime` and not after the `resumedAt` (if present), then saves the change

#### Scenario: Edit resumedAt
- **WHEN** operator clicks the edit icon on a pause log entry and changes the `resumedAt` datetime
- **THEN** system validates that `resumedAt` is after `pausedAt` and saves the change

#### Scenario: Invalid timestamp rejected
- **WHEN** operator submits an edit where `pausedAt` < session `startTime` OR `resumedAt` ≤ `pausedAt`
- **THEN** system shows an inline validation error and does NOT save the change

#### Scenario: Overlapping intervals rejected
- **WHEN** operator saves an edit that causes two pause intervals to overlap in time
- **THEN** system shows an inline error "Pause intervals cannot overlap" and does NOT save

### Requirement: Delete a pause log entry
The system SHALL allow an operator to delete a pause log entry.

#### Scenario: Delete completed pause entry
- **WHEN** operator clicks the delete icon on a pause log entry that has a `resumedAt`
- **THEN** system removes the entry from `sessionPauseLogs` and removes its ID from the session's `pauseLogIds`, recalculating billing accordingly

#### Scenario: Delete open pause entry restores session to running
- **WHEN** operator deletes the currently open pause entry (no `resumedAt`)
- **THEN** system removes the entry and sets session `status` back to `"running"`, effectively treating the pause as if it never happened

#### Scenario: Confirm before delete
- **WHEN** operator clicks delete on a pause entry
- **THEN** system shows a confirmation prompt before executing the deletion
