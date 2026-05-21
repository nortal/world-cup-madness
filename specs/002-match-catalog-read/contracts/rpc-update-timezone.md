# Contract — `update_timezone(p_timezone TEXT)` RPC

**Spec source**: FR-M15, FR-M16
**Implementation**: `supabase/migrations/0015_match_rpcs.sql`
**Caller**: `<TimezonePicker/>` Client Component (`components/profile/TimezonePicker.tsx`), invoked from `/profile` when the participant picks a new timezone and clicks Save.

## Purpose

Update the participant's stored timezone from the profile page. Mirrors the `update_display_name(text)` pattern established in feature 001 (migration 0007) so the audit + error-handling shape is identical.

## Signature

```sql
update_timezone(p_timezone TEXT) RETURNS jsonb
```

## Authentication

Authenticated, eligible Nortal participant (`is_eligible_nortal_user()`). SECURITY DEFINER + `auth.uid()` lookup, same as `set_timezone`.

## Authorization

`GRANT EXECUTE TO authenticated`.

## Input validation

Same three rules as `set_timezone`: non-empty, ≤ 64 chars, no whitespace. See [rpc-set-timezone.md](./rpc-set-timezone.md) for ERRCODE mapping.

## Behavior

```
1. v_user_id := auth.uid()
2. v_trimmed := trim(p_timezone)
3. Validate v_trimmed per rules above
4. UPDATE participants
     SET timezone = v_trimmed
   WHERE auth_user_id = v_user_id AND status = 'active'
5. IF NOT FOUND:
     RAISE EXCEPTION 'participant not found or inactive'
       USING ERRCODE = 'no_data_found'
6. RETURN jsonb_build_object('outcome', 'success', 'timezone', v_trimmed)
```

**Difference from `set_timezone`:** no `timezone = 'UTC'` guard. This RPC overwrites whatever the current value is. Calling it with the same value as the current `timezone` is a no-op at the data level (UPDATE fires but `OLD IS DISTINCT FROM NEW` is false, so the audit trigger's catch-all branch doesn't fire) — that's the intended Postgres-native behaviour and matches `update_display_name`.

## Audit trail

AFTER UPDATE trigger fires on the participants row mutation; the catch-all `OLD IS DISTINCT FROM NEW` branch writes a `participant.updated` row with the full OLD + NEW row JSONB (which includes the timezone change). Identical to display_name editing from feature 001 — no new audit infrastructure.

## Response shape

```json
{ "outcome": "success", "timezone": "America/Sao_Paulo" }
```

## Error responses (via PostgREST)

| Postgres ERRCODE | HTTP status | When |
|---|---|---|
| `check_violation` | 400 | Validation failure (empty / too-long / whitespace) |
| `no_data_found` | 404 | Participant row missing or status != 'active' |
| `42501` insufficient_privilege | 401 | Caller not authenticated |

## Test obligations (Phase 2 → pgTAP `008_*` + Playwright `timezone-profile-override.spec.ts`)

1. **Happy path (pgTAP)**: Set initial timezone, call `update_timezone('America/Sao_Paulo')`, assert column updated + audit_log has participant.updated row with `old_value.timezone = 'Europe/Tallinn'`, `new_value.timezone = 'America/Sao_Paulo'`.
2. **Same-value call**: Set timezone, call `update_timezone` with the SAME value, assert no audit row is appended (Postgres `IS DISTINCT FROM` short-circuit).
3. **Validation cases**: empty / too-long / whitespace each raise `check_violation`.
4. **Inactive participant (pgTAP)**: Soft-deactivate participant, call `update_timezone(...)`, assert `no_data_found` raised.
5. **E2E (Playwright `timezone-profile-override.spec.ts` → TC-M8)**: Sign in, navigate to `/profile`, select new timezone in the picker, click Save, assert success toast, navigate back to `/dashboard`, assert kickoff times now display in new TZ.
