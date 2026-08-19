## ADDED Requirements

### Requirement: Financial actors come only from authentication
Financial RPCs SHALL derive the actor from `auth.uid()` and active organization membership and SHALL reject client actor fields.

#### Scenario: Receptionist spoofs an administrator
- **WHEN** a payload contains another user's actor ID in a bill, payment, discount, movement, or audit
- **THEN** the RPC rejects the payload
- **AND** no row is written with the spoofed attribution

### Requirement: Role restrictions are enforced server-side
Replacement, void, refund, and bad-debt write-off SHALL require an administrator; settlement SHALL require active organization access consistent with the existing UI role policy.

#### Scenario: Non-admin calls replacement RPC directly
- **WHEN** an active receptionist or manager bypasses the UI and requests a replacement
- **THEN** the server rejects it with `role_access_denied`

### Requirement: Lifecycle attribution is not restamped
An operation SHALL update only its own lifecycle actor fields and preserve unrelated historical settlement, replacement, void, and issue actors.

#### Scenario: Settled bill is later refunded
- **WHEN** an administrator refunds a previously settled bill
- **THEN** void/refund attribution uses the administrator
- **AND** the original settlement actor remains unchanged
