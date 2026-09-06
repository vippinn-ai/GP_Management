## ADDED Requirements

### Requirement: Dashboard and Activity page share the normalized feed
The dashboard SHALL show at most ten recent normalized activity records with actor and IST time, and Show All SHALL navigate to the full Activity page.

#### Scenario: Operational-only realtime event
- **WHEN** an operational event has no audit row and does not change the legacy app-state version
- **THEN** its event ID invalidates both activity readers and the new record appears without a manual page reload

#### Scenario: Full-refresh realtime event
- **WHEN** an operational event requires a full normalized refresh but the app-state version is unchanged
- **THEN** the source event ID still invalidates both activity readers

### Requirement: Activity interaction remains responsive and accessible
The Activity page SHALL preserve input focus while editing filters, render hostile text as text, expose keyboard-operable disclosure controls with at least a 24-pixel target, and avoid rendering off-screen loaded rows.

#### Scenario: Mobile activity review
- **WHEN** the page is opened at 360 CSS pixels wide
- **THEN** filters, activity rows, and record details remain usable without horizontal overflow

#### Scenario: Large loaded history
- **WHEN** the user loads multiple pages
- **THEN** off-screen rows use browser content visibility containment while every loaded record remains searchable and accessible in the document

