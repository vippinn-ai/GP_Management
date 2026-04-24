## ADDED Requirements

### Requirement: Session card turns red when paused
When a session's `status` is `"paused"`, the station card SHALL display a visually distinct red appearance (border and/or background) so that operators can immediately identify paused sessions on the dashboard.

#### Scenario: Card is red while paused
- **WHEN** a session is paused (status = "paused")
- **THEN** the station card shows a red color scheme distinctly different from the "running" (active) state

#### Scenario: Card returns to normal on resume
- **WHEN** a paused session is resumed (status returns to "running")
- **THEN** the station card immediately reverts to its normal running appearance with no red indicators

### Requirement: Overtime animation after 10 minutes of pause
When a session has been continuously paused for 10 or more minutes, the station card SHALL display a repeating pulse or glow animation to draw attention.

#### Scenario: Animation starts at 10-minute mark
- **WHEN** a session's open pause log entry has `pausedAt` that is 10 or more minutes before the current time
- **THEN** the station card displays the overtime animation (CSS pulse/glow keyframe) in addition to the red color

#### Scenario: Animation not shown before 10 minutes
- **WHEN** a paused session's elapsed pause time is less than 10 minutes
- **THEN** the card is red but shows NO animation

#### Scenario: Animation stops on resume
- **WHEN** the paused session is resumed regardless of how long it was paused
- **THEN** both the red color and any animation are immediately removed

### Requirement: Pause duration is visible on the card
The station card SHALL show the current elapsed pause duration (e.g., "Paused 4m", "Paused 12m") as a live countdown while the session is paused.

#### Scenario: Live pause timer displayed
- **WHEN** a session is paused
- **THEN** the card shows a human-readable elapsed pause duration that updates at least every minute

#### Scenario: No pause timer when running
- **WHEN** a session is running
- **THEN** no pause duration text is shown on the card
