## ADDED Requirements

### Requirement: Every committed activity source is retained
The system SHALL retain exactly one activity evidence row for every organization-scoped `audit_logs` row and every `operational_events` row, keyed by source kind and source ID.

#### Scenario: Source backfill is complete
- **WHEN** the activity schema is installed or reinstalled
- **THEN** the union of audit and operational source IDs has zero missing and zero duplicate activity evidence rows

#### Scenario: Capture is race-safe
- **WHEN** a source row is committed while installation is in progress
- **THEN** the row is captured by a trigger installed before the backfill snapshot or by the subsequent backfill, and cannot fall between the two mechanisms

### Requirement: Complete server-authored activity wins duplicate presentation
The system SHALL retain both sources and suppress an audit presentation only when a securely correlated, complete server-authored operational projection covers the same semantic action.

#### Scenario: Current correlated sources
- **WHEN** an operational event references an audit ID and both rows have the same authenticated actor, organization, and transaction timestamp
- **THEN** the Activity UI suppresses the audit only if the operational projection is explicitly complete and maps to the same semantic action

#### Scenario: Generic multi-action correlation
- **WHEN** one generic operational event references multiple audit rows with distinct actions
- **THEN** each distinct audit action remains visible and the generic event cannot erase their detail

#### Scenario: Incomplete historical item projection
- **WHEN** a legacy item operational event lacks trusted item, quantity, or price detail
- **THEN** its correlated historical audit presentation remains visible with legacy provenance

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

### Requirement: Action provenance is explicit
The system SHALL present committed operational events as server-authoritative and SHALL label compatibility audit wording as client-reported unless the database mutation RPC validates and constructs that wording.

#### Scenario: Hostile compatibility audit wording
- **WHEN** a caller performs a session operation but supplies audit wording that claims an unrelated billing action
- **THEN** the server session operation remains visible as authoritative and the conflicting audit wording is visibly labelled Client-reported context

#### Scenario: Canonical financial audit wording
- **WHEN** phase 10 validates an allowed financial action and constructs its per-bill message from committed rows
- **THEN** that audit context is marked server-canonical and is not labelled client-reported
