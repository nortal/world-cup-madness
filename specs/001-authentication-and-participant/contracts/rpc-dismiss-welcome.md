# RPC Contract: `dismiss_welcome`

**Endpoint**: `POST /rest/v1/rpc/dismiss_welcome`
**Caller**: Welcome-modal "Got it" button (Client Component)
**Authorization**: `authenticated` role; participant must be `status = 'active'`

## Description

Sets `participants.welcome_dismissed_at` to `now()` if not already set. **Idempotent** — calling on an already-dismissed participant is a no-op (preserves the original timestamp).

## Request

No body required (POST with empty `{}`).

## Response

```typescript
type DismissWelcomeResult = { outcome: 'success' };
```

HTTP `200`.

## Side effects

- `UPDATE participants SET welcome_dismissed_at = COALESCE(welcome_dismissed_at, now()) WHERE auth_user_id = auth.uid() AND status = 'active'`
- AFTER UPDATE trigger writes `participant.updated` audit row **only on first dismissal** (subsequent calls don't change the row, so the trigger sees `OLD = NEW` and emits no audit entry per the trigger's `OLD IS DISTINCT FROM NEW` guard)

## Acceptance tests

- **TC-12** — Welcome dismissed persists cross-device: dismiss on device A, verify modal does NOT reappear on device B
