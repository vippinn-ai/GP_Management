## ADDED Requirements

### Requirement: Every committed activity source is retained
The system SHALL retain exactly one activity evidence row for every organization-scoped `audit_logs` row and every `operational_events` row, keyed by source kind and source ID.

#### Scenario: Source backfill is complete
- **WHEN** the activity schema is installed or reinstalled
- **THEN** the union of audit and operational source IDs has zero missing and zero duplicate activity evidence rows

#### Scenario: Capture is race-safe
- **WHEN** a source row is committed while installation is in progress
- **THEN** the row is captured by a trigger installed before the backfill snapshot or by the subsequent backfill, and cannot fall between the two mechanisms

### Requirement: Server-authored activity wins presentation
The system SHALL retain both sources but present the server-authored operational action once when an audit row and operational event are securely correlated.

#### Scenario: Current correlated sources
- **WHEN** an operational event references an audit ID and both rows have the same authenticated actor, organization, and transaction timestamp
- **THEN** the Activity UI presents the operational action and suppresses only the duplicate audit presentation

#### Scenario: Reused historical audit ID
- **WHEN** a new operational event references an older audit ID
- **THEN** the new operational action remains visible and the older audit evidence is not suppressed

#### Scenario: Deployed reference formats
- **WHEN** references appear as `audit_log_id`, `audit_log_ids`, or `changed_rows.audit_logs`
- **THEN** one canonical extractor returns the normalized distinct reference IDs for trigger capture, backfill, and verification

### Requirement: Attribution is immutable
The system SHALL derive actor and timestamp for new activity from `auth.uid()` and database time, and SHALL prevent authenticated application users from updating or deleting evidence sources directly.

#### Scenario: Spoofed actor and time
- **WHEN** an authenticated mutation submits another actor or a client timestamp
- **THEN** the activity row records the authenticated member and server transaction time

