# RPC Contract: `update_display_name`

**Endpoint**: `POST /rest/v1/rpc/update_display_name`
**Caller**: Next.js profile-page edit form (Client Component)
**Authorization**: `authenticated` role; participant must be `status = 'active'`

## Description

Updates the calling participant's `display_name`. Trims whitespace; rejects empty or > 100 chars. Audited via the standard `participants` UPDATE trigger.

## Request

```json
{
  "new_name": "Mike H."
}
```

## Response

```typescript
type UpdateDisplayNameResult = { outcome: 'success'; display_name: string };
```

HTTP `200` on success.

## Errors

| HTTP / SQLSTATE | Meaning |
|---|---|
| 400 / `check_violation` (23514) | `new_name` is empty after trim, or > 100 chars |
| 404 / `no_data_found` (P0002) | Participant not found or inactive |
| 401 | Not authenticated |

## Side effects

- `UPDATE participants SET display_name = trim(new_name) WHERE auth_user_id = auth.uid() AND status = 'active'`
- AFTER UPDATE trigger writes `participant.updated` audit row with `old_value` + `new_value` for `display_name`

## Acceptance tests

- **TC-4** — Display-name change persists; audit entry written; new name appears on leaderboard
