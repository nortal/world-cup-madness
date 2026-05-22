# RPC Contract: `provision_participant_from_jwt`

**Endpoint**: `POST /rest/v1/rpc/provision_participant_from_jwt`
**Caller**: Next.js auth callback Route Handler (`app/auth/callback/route.ts`)
**Authorization**: `authenticated` role (uses `auth.jwt()` and `auth.uid()`)

## Description

Reads JWT claims from the current Supabase session, validates tenant eligibility against `tournament_config.nortal_tenant_id`, and either provisions a new participant row or updates an existing one. Soft-deactivates participants whose tenant membership has been revoked. Re-evaluates admin role on every call.

## Request

No request body. All inputs come from the JWT.

## Response

```typescript
type ProvisionOutcome =
    | { outcome: 'success';  participant_id: string; role: 'participant' | 'admin'; is_first_login: boolean }
    | { outcome: 'rejected'; reason: 'tenant.mismatch' }
    | { outcome: 'error';    reason: 'config.missing' };
```

HTTP `200` in all cases. The `outcome` field tells the caller which redirect to apply:
- `success` → `/dashboard` (welcome modal shown if `is_first_login`)
- `rejected` → `/access-denied`
- `error` → `/auth-error`

## Side effects

| Outcome | Side effects |
|---|---|
| `success` (new user) | INSERT into `participants` → trigger writes `participant.created` audit row |
| `success` (returning user) | UPDATE `participants` (`last_login_at`, `role` refresh, `email` refresh, `status` re-activate); trigger writes `participant.updated` or `participant.role-changed` if changed |
| `success` (returning, was inactive but now eligible) | UPDATE `status` to `active` → trigger writes `participant.updated` |
| `rejected` (existing active user) | UPDATE `participants` SET `status='inactive'` → trigger writes `participant.deactivated` (reason: `tenant.departure`) + `record_auth_failure('auth.rejected', …)` writes `auth.rejected` audit row |
| `rejected` (new ineligible user) | `record_auth_failure('auth.rejected', …)` writes `auth.rejected`; **no participant row created** (FC-2) |
| `error` | `record_auth_failure('auth.provider-error', …)` writes `auth.provider-error` audit row |

## Error cases

| Result | Cause | Caller behaviour |
|---|---|---|
| `outcome: 'error', reason: 'config.missing'` | `tournament_config.nortal_tenant_id IS NULL` | Redirect to `/auth-error` (FC-1) |
| HTTP 401 | No valid Supabase session | Should not happen — caller invokes only after `exchangeCodeForSession` succeeds |
| HTTP 500 | Unexpected DB error | Caller logs + redirects to `/auth-error` |

## Acceptance tests (mapped from spec)

- **TC-1** (new eligible) → `outcome: success, is_first_login: true`
- **TC-2** (returning eligible) → `outcome: success, is_first_login: false`
- **TC-3** (admin) → `outcome: success, role: 'admin'`
- **TC-5** (ineligible) → `outcome: rejected`; no participant row created (verified via pgTAP)
- **TC-6** (tenant departure) → existing participant `status` flipped to inactive; both `participant.deactivated` and `auth.rejected` audit rows written
- **TC-9** (role downgrade) → role updated `admin` → `participant`; `participant.role-changed` audit row
