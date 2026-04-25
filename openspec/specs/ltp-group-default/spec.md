## ADDED Requirements

### Requirement: LTP-enabled stations default playMode to group
When starting a new session on a station with `ltpEnabled: true`, the initial `playMode` in the start-session form SHALL default to `"group"`, not `"solo"`.

#### Scenario: Group is pre-selected on LTP station
- **WHEN** operator opens the start-session dialog for a station where `station.ltpEnabled = true`
- **THEN** the playMode selector shows "Group" as the pre-selected option

#### Scenario: Operator can still choose solo
- **WHEN** the start-session dialog opens with "Group" defaulted
- **THEN** operator can change the selection to "Solo (LTP)" before starting the session

#### Scenario: Non-LTP stations unaffected
- **WHEN** operator opens the start-session dialog for a station where `station.ltpEnabled = false`
- **THEN** playMode is automatically fixed to "group" (no selector shown), same as current behavior
