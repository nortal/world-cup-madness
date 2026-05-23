# RPC Contract: `record_auth_failure` (Internal)

**Endpoint**: `POST /rest/v1/rpc/record_auth_failure`
**Caller**:
- `provision_participant_from_jwt()` (internal Postgres-to-Postgres call, runs under SECURITY DEFINER context)
- Next.js auth callback Route Handler (when `supabase.auth.exchangeCodeForSession()` itself fails — before we even have a session)
**Authorization**: `authenticated` AND `service_role`

## Description

Writes one entry to `audit_log` with one of the auth-failure actions. This is the only path through which application code can insert directly into `audit_log` for auth failures (the participants triggers handle success-path events).

## Request

```json
{
  "p_action":         "auth.rejected" | "auth.provider-error",
  "p_oid":            "<microsoft-object-uuid-or-null>",
  "p_email":          "<canonical-email-or-null>",
  "p_attempted_tid":  "<microsoft-tenant-uuid-or-null>",
  "p_reason":         "tenant.mismatch | provider.5xx | callback.state-mismatch | callback.exchange-failed | token.exchange-failed | config.missing"
}
```

## Response

```json
{}
```

HTTP `200`.

## Errors

| HTTP / SQLSTATE | Meaning |
|---|---|
| 400 / `check_violation` (23514) | `p_action` not in the allowed set |
| 401 | Not authenticated AND not service_role |

## Acceptance tests

- **TC-5** — `auth.rejected` row visible in audit log
- **TC-6** — `auth.rejected` row written when previously-eligible user fails check
- **TC-8** — admin audit search returns auth-failure rows with `actor_oid + actor_email + attempted_tid` populated
- **TC-10** — `auth.provider-error` row written when callback exchange fails
