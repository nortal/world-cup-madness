# Phase 1 Data Model: Authentication and Participant Provisioning

**Feature**: 001-authentication-and-participant
**Date**: 2026-05-15

This document specifies the schema for the auth subsystem. Migrations live in `supabase/migrations/`. Implementation happens in `/ai1st-dev-implement`.

---

## Extensions

### `citext` (case-insensitive text)

Required for `participants.email` per R-4. Migration `0001_extensions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS citext;
```

---

## Tables

### `tournament_config`

Singleton configuration row. Holds operational values that gate sign-in.

```sql
CREATE TABLE tournament_config (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    nortal_tenant_id UUID NOT NULL,                    -- FC-1 fail-closed
    admin_oids       UUID[] NOT NULL DEFAULT '{}',     -- ADR-002 explicit admin allow-list
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Constraints**:
- Singleton (`CHECK (id = 1)`): only one row ever exists
- `nortal_tenant_id` `NOT NULL`: enforces FC-1 (fail-closed if missing)

**Access pattern**:
- Read by RLS predicate `is_eligible_nortal_user()` on every authenticated query
- Read by `provision_participant_from_jwt()` on every sign-in
- Write only via `service_role` (admin SQL or future admin UI); no direct PostgREST exposure for INSERT/UPDATE

---

### `participants`

Authoritative identity record for eligible Nortal collaborators.

```sql
CREATE TABLE participants (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id          UUID NOT NULL UNIQUE
                              REFERENCES auth.users(id) ON DELETE RESTRICT,
    oid                   UUID NOT NULL UNIQUE,           -- Microsoft object ID
    email                 CITEXT NOT NULL UNIQUE,         -- Case-insensitive (citext)
    display_name          TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'participant'
                              CHECK (role IN ('participant', 'admin')),
    status                TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at         TIMESTAMPTZ,
    welcome_dismissed_at  TIMESTAMPTZ                      -- C4: nullable timestamp
);

CREATE INDEX participants_oid_idx ON participants(oid);
CREATE INDEX participants_role_active_idx ON participants(role) WHERE status = 'active';

-- Trim trigger (R-4): explicit whitespace normalization
CREATE OR REPLACE FUNCTION trim_participant_email()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.email := trim(NEW.email::text)::citext;
    RETURN NEW;
END $$;

CREATE TRIGGER trim_email_before_insert_or_update
    BEFORE INSERT OR UPDATE OF email ON participants
    FOR EACH ROW EXECUTE FUNCTION trim_participant_email();
```

**Constraints**:
- `oid` UNIQUE — one participant per Microsoft account
- `email` UNIQUE on `citext` — case-insensitive uniqueness (R-4 / C5)
- `auth_user_id` UNIQUE FK to `auth.users`
- CHECK constraints on `role` and `status` enumerate allowed values

**State transitions** (all via SECURITY DEFINER RPC functions; no direct UPDATE policies on the table):

| From | To | Trigger | Audit action |
|---|---|---|---|
| (none) | INSERT (active) | `provision_participant_from_jwt()` first call | `participant.created` |
| display_name = X | display_name = Y | `update_display_name(Y)` | `participant.updated` |
| welcome_dismissed_at = NULL | welcome_dismissed_at = now() | `dismiss_welcome()` | `participant.updated` |
| role = participant | role = admin | `provision_participant_from_jwt()` (oid added to admin_oids) | `participant.role-changed` |
| role = admin | role = participant | `provision_participant_from_jwt()` (oid removed from admin_oids) | `participant.role-changed` |
| status = active | status = inactive | `provision_participant_from_jwt()` (tid mismatch on returning user) | `participant.deactivated` (reason: `tenant.departure`) |
| status = inactive | status = active | `provision_participant_from_jwt()` (re-eligible) | `participant.updated` |

DELETE is **prohibited** (no DELETE policy; FK from audit_log uses `ON DELETE SET NULL` to keep history if a row is forcibly deleted by service_role).

---

### `audit_log`

Single tamper-resistant event trail (ADR-010).

```sql
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    action          TEXT NOT NULL CHECK (action IN (
        'participant.created',
        'participant.updated',
        'participant.deactivated',
        'participant.role-changed',
        'auth.rejected',
        'auth.provider-error'
    )),
    actor_oid       UUID,
    actor_email     CITEXT,
    participant_id  UUID REFERENCES participants(id) ON DELETE SET NULL,
    entity_type     TEXT,
    entity_id       UUID,
    old_value       JSONB,
    new_value       JSONB,
    attempted_tid   UUID,                    -- For auth.rejected entries
    reason          TEXT
);

CREATE INDEX audit_log_occurred_at_idx ON audit_log(occurred_at DESC);
CREATE INDEX audit_log_action_idx       ON audit_log(action);
CREATE INDEX audit_log_actor_oid_idx    ON audit_log(actor_oid);
CREATE INDEX audit_log_participant_id_idx
    ON audit_log(participant_id) WHERE participant_id IS NOT NULL;
```

**Constraints**:
- `participant_id` is **nullable** (ADR-010): `auth.rejected` and `auth.provider-error` events have no participant row
- `action` CHECK enumerates all currently-allowed values; new actions require schema migration

**Mutations** (no UPDATE/DELETE policies — tamper-resistant):
- INSERT only via SECURITY DEFINER trigger functions or RPC

---

## Audit Trigger

Migration `0005_audit_triggers.sql`:

```sql
CREATE OR REPLACE FUNCTION audit_participants_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log (action, actor_oid, actor_email, participant_id,
                               entity_type, entity_id, new_value)
        VALUES ('participant.created', NEW.oid, NEW.email, NEW.id,
                'participants', NEW.id, to_jsonb(NEW));
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'inactive' THEN
            INSERT INTO audit_log (action, actor_oid, actor_email, participant_id,
                                   entity_type, entity_id, old_value, new_value, reason)
            VALUES ('participant.deactivated', NEW.oid, NEW.email, NEW.id,
                    'participants', NEW.id,
                    jsonb_build_object('status', OLD.status),
                    jsonb_build_object('status', NEW.status),
                    'tenant.departure');
        ELSIF OLD.role IS DISTINCT FROM NEW.role THEN
            INSERT INTO audit_log (action, actor_oid, actor_email, participant_id,
                                   entity_type, entity_id, old_value, new_value)
            VALUES ('participant.role-changed', NEW.oid, NEW.email, NEW.id,
                    'participants', NEW.id,
                    jsonb_build_object('role', OLD.role),
                    jsonb_build_object('role', NEW.role));
        ELSIF OLD IS DISTINCT FROM NEW THEN
            INSERT INTO audit_log (action, actor_oid, actor_email, participant_id,
                                   entity_type, entity_id, old_value, new_value)
            VALUES ('participant.updated', NEW.oid, NEW.email, NEW.id,
                    'participants', NEW.id, to_jsonb(OLD), to_jsonb(NEW));
        END IF;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER audit_participants_after_insert
    AFTER INSERT ON participants
    FOR EACH ROW EXECUTE FUNCTION audit_participants_changes();

CREATE TRIGGER audit_participants_after_update
    AFTER UPDATE ON participants
    FOR EACH ROW EXECUTE FUNCTION audit_participants_changes();
```

---

## SECURITY DEFINER Functions

### `provision_participant_from_jwt()`

Migration `0006_provision_function.sql`. Called by the auth callback Route Handler after Supabase Auth issues a session.

```sql
CREATE OR REPLACE FUNCTION provision_participant_from_jwt()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_tid           UUID;
    v_oid           UUID;
    v_email         CITEXT;
    v_display_name  TEXT;
    v_user_id       UUID := auth.uid();
    v_config        tournament_config%ROWTYPE;
    v_existing      participants%ROWTYPE;
    v_new_role      TEXT;
BEGIN
    -- Custom claims live in app_metadata (Supabase convention; set by the
    -- before-issue-token hook in production and by admin.createUser in tests).
    -- See migration 0010_fix_jwt_claim_reads.sql for the rationale.
    v_tid := (auth.jwt() -> 'app_metadata' ->> 'tid')::UUID;
    v_oid := (auth.jwt() -> 'app_metadata' ->> 'oid')::UUID;
    v_email := (auth.jwt() ->> 'email')::CITEXT;
    v_display_name := COALESCE(
        NULLIF(trim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
        NULLIF(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
        split_part(auth.jwt() ->> 'email', '@', 1)  -- email local-part fallback
    );

    -- Load config (FC-1 fail-closed)
    SELECT * INTO v_config FROM tournament_config WHERE id = 1;
    IF NOT FOUND OR v_config.nortal_tenant_id IS NULL THEN
        PERFORM record_auth_failure('auth.provider-error', v_oid, v_email, v_tid, 'config.missing');
        RETURN jsonb_build_object('outcome', 'error', 'reason', 'config.missing');
    END IF;

    -- Tenant eligibility (FR-001/002)
    IF v_tid IS DISTINCT FROM v_config.nortal_tenant_id THEN
        SELECT * INTO v_existing FROM participants WHERE oid = v_oid;
        IF FOUND AND v_existing.status = 'active' THEN
            UPDATE participants SET status = 'inactive' WHERE id = v_existing.id;
            -- Trigger writes 'participant.deactivated' (reason: tenant.departure)
        END IF;
        PERFORM record_auth_failure('auth.rejected', v_oid, v_email, v_tid, 'tenant.mismatch');
        RETURN jsonb_build_object('outcome', 'rejected', 'reason', 'tenant.mismatch');
    END IF;

    -- Role from admin allow-list
    v_new_role := CASE WHEN v_oid = ANY(v_config.admin_oids) THEN 'admin' ELSE 'participant' END;

    -- Provision or update
    SELECT * INTO v_existing FROM participants WHERE oid = v_oid;
    IF NOT FOUND THEN
        INSERT INTO participants (auth_user_id, oid, email, display_name,
                                  role, status, last_login_at)
        VALUES (v_user_id, v_oid, v_email, v_display_name, v_new_role, 'active', now())
        RETURNING * INTO v_existing;
        -- Trigger writes 'participant.created'
    ELSE
        UPDATE participants
        SET last_login_at = now(),
            role = v_new_role,
            status = 'active',          -- re-activate if previously inactive
            email = v_email             -- refresh in case Microsoft-side changed
            -- Note: display_name NOT auto-overwritten (preserve user customisation per spec deferred decision)
        WHERE id = v_existing.id;
        -- Trigger writes 'participant.role-changed' or 'participant.updated' as appropriate
    END IF;

    RETURN jsonb_build_object(
        'outcome', 'success',
        'participant_id', v_existing.id,
        'role', v_new_role,
        'is_first_login', v_existing.welcome_dismissed_at IS NULL
    );
END $$;

REVOKE ALL ON FUNCTION provision_participant_from_jwt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_participant_from_jwt() TO authenticated;
```

### `update_display_name(new_name TEXT)`

Migration `0007_profile_functions.sql`:

```sql
CREATE OR REPLACE FUNCTION update_display_name(new_name TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id   UUID := auth.uid();
    v_trimmed   TEXT := trim(new_name);
BEGIN
    IF v_trimmed IS NULL OR length(v_trimmed) = 0 THEN
        RAISE EXCEPTION 'display_name cannot be empty' USING ERRCODE = 'check_violation';
    END IF;
    IF length(v_trimmed) > 100 THEN
        RAISE EXCEPTION 'display_name too long (max 100 chars)' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE participants
    SET display_name = v_trimmed
    WHERE auth_user_id = v_user_id AND status = 'active';
    -- Trigger writes 'participant.updated'

    IF NOT FOUND THEN
        RAISE EXCEPTION 'participant not found or inactive' USING ERRCODE = 'no_data_found';
    END IF;

    RETURN jsonb_build_object('outcome', 'success', 'display_name', v_trimmed);
END $$;

REVOKE ALL ON FUNCTION update_display_name(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_display_name(TEXT) TO authenticated;
```

### `dismiss_welcome()`

```sql
CREATE OR REPLACE FUNCTION dismiss_welcome()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    UPDATE participants
    SET welcome_dismissed_at = COALESCE(welcome_dismissed_at, now())
    WHERE auth_user_id = v_user_id AND status = 'active';

    RETURN jsonb_build_object('outcome', 'success');
END $$;

REVOKE ALL ON FUNCTION dismiss_welcome() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dismiss_welcome() TO authenticated;
```

### `record_auth_failure(...)`

```sql
CREATE OR REPLACE FUNCTION record_auth_failure(
    p_action          TEXT,
    p_oid             UUID,
    p_email           CITEXT,
    p_attempted_tid   UUID,
    p_reason          TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_action NOT IN ('auth.rejected', 'auth.provider-error') THEN
        RAISE EXCEPTION 'Invalid action for record_auth_failure: %', p_action
            USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO audit_log (action, actor_oid, actor_email, attempted_tid, reason)
    VALUES (p_action, p_oid, p_email, p_attempted_tid, p_reason);
END $$;

REVOKE ALL ON FUNCTION record_auth_failure(TEXT, UUID, CITEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_auth_failure(TEXT, UUID, CITEXT, UUID, TEXT)
    TO authenticated, service_role;
```

---

## Reusable RLS Predicate

Defined in migration `0008_rls_policies.sql` and updated in `0010_fix_jwt_claim_reads.sql`
to read from `app_metadata` (Supabase convention for custom claims):

```sql
-- ADR-009: per-request tenant eligibility check
CREATE OR REPLACE FUNCTION is_eligible_nortal_user()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, auth
AS $$
    SELECT (auth.jwt() -> 'app_metadata' ->> 'tid')::UUID
        = (SELECT nortal_tenant_id FROM tournament_config WHERE id = 1)
$$;
```

This predicate is the foundation of every RLS policy in this and future features.

---

## Row-Level Security Policies

### `participants`

```sql
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;

-- Read own row (any authenticated active participant)
CREATE POLICY participants_select_own ON participants
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND auth_user_id = auth.uid());

-- Read other active participants' display_name + role for leaderboard (ADR-006)
-- (column-level email gating done via the participants_public view; see below)
CREATE POLICY participants_select_active_for_leaderboard ON participants
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND status = 'active');

-- Admin reads everything (including email)
CREATE POLICY participants_admin_select_all ON participants
    FOR SELECT TO authenticated
    USING (
        is_eligible_nortal_user() AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.auth_user_id = auth.uid()
                  AND p.role = 'admin'
                  AND p.status = 'active'
        )
    );

-- INSERT, UPDATE, DELETE deliberately have NO policies for `authenticated`
-- All mutations go through SECURITY DEFINER RPCs.
```

### `tournament_config`

```sql
ALTER TABLE tournament_config ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can SELECT (RLS predicate needs access)
CREATE POLICY tournament_config_select ON tournament_config
    FOR SELECT TO authenticated
    USING (true);

-- No INSERT/UPDATE/DELETE policy — service_role only (or future admin RPC)
```

### `audit_log`

```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_admin_select ON audit_log
    FOR SELECT TO authenticated
    USING (
        is_eligible_nortal_user() AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.auth_user_id = auth.uid()
                  AND p.role = 'admin'
                  AND p.status = 'active'
        )
    );

-- INSERT only via SECURITY DEFINER triggers / functions (no direct policy)
-- UPDATE / DELETE prohibited (no policies → tamper-resistant)
```

---

## Public-safe Leaderboard View

ADR-006: display name visible to all participants; email admin-only.

```sql
CREATE VIEW participants_public AS
SELECT id, oid, display_name, role, status, created_at, last_login_at
FROM participants;

GRANT SELECT ON participants_public TO authenticated;
-- email is NOT included; admins query the underlying table directly
```

The view inherits the underlying table's RLS, so the leaderboard SELECT uses `participants_select_active_for_leaderboard`.

---

## Data Quality Checklist

- [x] All tables have primary keys
- [x] Foreign keys cascade or restrict explicitly
- [x] Unique constraints (`oid`, `email`, `auth_user_id`)
- [x] CHECK constraints enumerate enums (`role`, `status`, `action`)
- [x] Indexes on lookup + audit-search columns
- [x] RLS enabled on every table; policies present for every legitimate access path
- [x] No direct INSERT / UPDATE / DELETE on `audit_log` from `authenticated`
- [x] All SECURITY DEFINER functions REVOKE then GRANT explicitly
- [x] No PII (`email`) in views accessible to non-admin roles
- [x] FC-1 enforced (`nortal_tenant_id NOT NULL`)
- [x] FC-2 enforced (no INSERT policy for `authenticated`; provision function rejects ineligible before insert)

---

## Migration Order (chronological filename prefix)

1. `0001_extensions.sql` — `CREATE EXTENSION citext`
2. `0002_create_tournament_config.sql` — config table
3. `0003_create_participants.sql` — participants table + trim trigger
4. `0004_create_audit_log.sql` — audit_log table
5. `0005_audit_triggers.sql` — `audit_participants_changes()` + triggers
6. `0006_provision_function.sql` — `provision_participant_from_jwt()` + `record_auth_failure()`
7. `0007_profile_functions.sql` — `update_display_name()`, `dismiss_welcome()`
8. `0008_rls_policies.sql` — `is_eligible_nortal_user()` + RLS policies + `participants_public` view
9. `0009_seed_admin.sql` — Seed `tournament_config` row (tenant_id from env, initial admin oids)
