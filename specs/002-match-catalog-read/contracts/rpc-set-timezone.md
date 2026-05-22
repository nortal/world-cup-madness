# Contract — `set_timezone(p_timezone TEXT)` RPC

**Spec source**: FR-M14, FR-M13
**Implementation**: `supabase/migrations/0015_match_rpcs.sql`
**Caller**: `<TimezoneAutoDetect/>` Client Component (`components/matches/TimezoneAutoDetect.tsx`), invoked once on first dashboard mount when the participant's stored `timezone` is still the default `'UTC'`.

## Purpose

Persist the participant's browser-detected timezone on first sign-in. This is the one-shot RPC; subsequent edits go through `update_timezone` (see [rpc-update-timezone.md](./rpc-update-timezone.md)).

## Signature

```sql
set_timezone(p_timezone TEXT) RETURNS jsonb
```

## Authentication

Caller must be an authenticated, eligible Nortal participant (`is_eligible_nortal_user()`). The RPC is SECURITY DEFINER but reads `auth.uid()` to identify the row to update — there is no way to set another participant's timezone.

## Authorization

`GRANT EXECUTE TO authenticated`. RLS does not apply (SECURITY DEFINER bypasses RLS), but the `WHERE auth_user_id = auth.uid() AND status = 'active'` clause ensures only the caller's own active participant row is touched.

## Input validation

| Field | Rule | On violation |
|---|---|---|
| `p_timezone` | `length > 0` | `RAISE EXCEPTION 'timezone cannot be empty' USING ERRCODE = 'check_violation'` |
| `p_timezone` | `length <= 64` | `RAISE EXCEPTION 'timezone too long (max 64 chars)' USING ERRCODE = 'check_violation'` |
| `p_timezone` | No whitespace anywhere | `RAISE EXCEPTION 'timezone must not contain whitespace' USING ERRCODE = 'check_violation'` |

(IANA validity itself is not server-enforced — see `data-model.md` rationale + the renderer-side fallback edge case in spec §3.)

## Behavior

```
1. v_user_id := auth.uid()
2. UPDATE participants
     SET timezone = p_timezone
   WHERE auth_user_id = v_user_id
     AND status = 'active'
     AND timezone = 'UTC'   -- guards: one-shot, only overwrites the default
3. IF FOUND:
     RETURN jsonb_build_object('outcome', 'success', 'timezone', p_timezone)
4. ELSE:
     -- Either the row didn't exist, the participant isn't active, or
     -- the timezone has already been set (StrictMode double-fire,
     -- second-tab race, etc.) — all are no-ops, not errors.
     RETURN jsonb_build_object(
       'outcome', 'no-op',
       'reason', 'already-set-or-not-eligible'
     )
```

## Audit trail

The existing `audit_participants_changes()` AFTER UPDATE trigger from migration 0005 picks up the `timezone` change automatically and writes a `participant.updated` audit row with the old + new timezone in the `old_value` / `new_value` JSONB columns. No manual audit_log INSERT needed in this RPC.

## Response shape

```json
// Success
{ "outcome": "success", "timezone": "Europe/Tallinn" }

// No-op (already set, or StrictMode double-fire)
{ "outcome": "no-op", "reason": "already-set-or-not-eligible" }
```

## Error responses (via PostgREST)

| Postgres ERRCODE | HTTP status | When |
|---|---|---|
| `check_violation` | 400 | Empty / too-long / whitespace `p_timezone` |
| `42501` insufficient_privilege | 401 | Caller not authenticated |

## Test obligations (Phase 2 → pgTAP `008_*` + Jest)

1. **Happy path**: Provision a participant, call `set_timezone('Europe/Tallinn')`, assert `participants.timezone = 'Europe/Tallinn'`, assert `audit_log` has a `participant.updated` row with the old + new values.
2. **One-shot semantics**: Call `set_timezone('Europe/Tallinn')` twice. Second call returns `{outcome:'no-op'}`; participants.timezone unchanged after second call; audit_log has exactly one row from the timezone change.
3. **Validation — empty**: `set_timezone('')` raises `check_violation`.
4. **Validation — too long**: `set_timezone(repeat('a', 65))` raises `check_violation`.
5. **Validation — whitespace**: `set_timezone('Europe/Tal linn')` raises `check_violation`.
6. **Inactive participant**: Soft-deactivate participant (status='inactive'), call `set_timezone(...)`. Returns `{outcome:'no-op'}` (the WHERE filter excludes inactive participants); no row updated.
7. **Anonymous caller**: Direct invocation without an authenticated session returns 401 from PostgREST (RPC never executes).
