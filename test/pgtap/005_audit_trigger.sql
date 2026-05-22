-- pgTAP test: T022 — audit_participants_changes() trigger behaviour
--
-- Source migration: supabase/migrations/0005_audit_triggers.sql
-- Spec reference:   specs/001-authentication-and-participant/data-model.md
--                   §"Audit Trigger" (~lines 151–187)
--
-- Invariants under test (matching the IF/ELSIF chain in the trigger function):
--   * INSERT on participants    → audit_log row with action='participant.created',
--                                 new_value=to_jsonb(NEW), no old_value.
--   * UPDATE of role (only)     → action='participant.role-changed',
--                                 old_value={'role': OLD.role}, new_value={'role': NEW.role}.
--   * UPDATE of status→inactive → action='participant.deactivated',
--                                 reason='tenant.departure',
--                                 old_value={'status':'active'}, new_value={'status':'inactive'}.
--                                 (status takes precedence over role in the ELSIF chain).
--   * Any other UPDATE          → action='participant.updated',
--                                 old_value=to_jsonb(OLD), new_value=to_jsonb(NEW).
--   * Combined UPDATE (role + status→inactive): the trigger uses ELSIF, so it
--     writes exactly ONE row, and the deactivation branch wins (status check is first).
--
-- Schema notes (from 0004_create_audit_log.sql):
--   * No `metadata` JSONB column — the trigger uses three separate columns:
--       old_value JSONB, new_value JSONB, reason TEXT.
--   * action is constrained to the enum: participant.created / .updated /
--     .deactivated / .role-changed / auth.rejected / auth.provider-error.
--
-- Test isolation:
--   * Wrapped in BEGIN/ROLLBACK so audit_log mutations and auth.users seed
--     rows do not persist.
--   * Uses fixed UUIDs for the auth.users row, participant.oid, and the
--     participant.id is assigned via DEFAULT gen_random_uuid() and captured.

BEGIN;

SELECT plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- The participants.auth_user_id FK references auth.users(id) ON DELETE RESTRICT.
-- Seed one auth.users row inside this transaction; ROLLBACK at the end removes it.
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES (
    '11111111-1111-1111-1111-111111111111'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'authenticated',
    'authenticated',
    'audit-test@nortal.com'
);

-- Stable IDs for cross-test references.
-- participant_oid is the Entra ID `oid` — used by trigger for actor_oid in audit rows.
\set participant_oid '\'22222222-2222-2222-2222-222222222222\''

-- ---------------------------------------------------------------------------
-- Test 1 — INSERT writes 'participant.created'
-- ---------------------------------------------------------------------------
WITH new_p AS (
    INSERT INTO participants (auth_user_id, oid, email, display_name)
    VALUES (
        '11111111-1111-1111-1111-111111111111'::uuid,
        :participant_oid::uuid,
        'audit-test@nortal.com',
        'Audit Test User'
    )
    RETURNING id
)
SELECT id AS pid INTO TEMP TABLE t_pid FROM new_p;

SELECT is(
    (SELECT count(*)::int
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.created'),
    1,
    'INSERT writes exactly one participant.created audit row'
);

SELECT is(
    (SELECT new_value->>'email'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.created'),
    'audit-test@nortal.com',
    'participant.created new_value is to_jsonb(NEW) — includes email'
);

SELECT is(
    (SELECT old_value
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.created'),
    NULL,
    'participant.created has NULL old_value (INSERT has no OLD row)'
);

SELECT is(
    (SELECT actor_oid
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.created'),
    :participant_oid::uuid,
    'participant.created actor_oid equals NEW.oid'
);

-- ---------------------------------------------------------------------------
-- Test 2 — UPDATE of role only writes 'participant.role-changed'
-- ---------------------------------------------------------------------------
UPDATE participants
   SET role = 'admin'
 WHERE id = (SELECT pid FROM t_pid);

SELECT is(
    (SELECT count(*)::int
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.role-changed'),
    1,
    'UPDATE role writes exactly one participant.role-changed row'
);

SELECT is(
    (SELECT old_value->>'role'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.role-changed'),
    'participant',
    'role-changed old_value->>role captures previous role'
);

SELECT is(
    (SELECT new_value->>'role'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.role-changed'),
    'admin',
    'role-changed new_value->>role captures new role'
);

SELECT is(
    (SELECT reason
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.role-changed'),
    NULL,
    'role-changed has NULL reason column'
);

-- ---------------------------------------------------------------------------
-- Test 3 — Other UPDATE (display_name) writes 'participant.updated'
-- ---------------------------------------------------------------------------
-- Done BEFORE the status update because once status='inactive' the row is
-- visually "departed"; we still want a clean .updated event distinct from
-- .role-changed and .deactivated.
UPDATE participants
   SET display_name = 'Audit Test User Renamed'
 WHERE id = (SELECT pid FROM t_pid);

SELECT is(
    (SELECT count(*)::int
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.updated'),
    1,
    'UPDATE of display_name writes exactly one participant.updated row'
);

SELECT is(
    (SELECT old_value->>'display_name'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.updated'),
    'Audit Test User',
    'participant.updated old_value is to_jsonb(OLD) — captures previous display_name'
);

SELECT is(
    (SELECT new_value->>'display_name'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.updated'),
    'Audit Test User Renamed',
    'participant.updated new_value is to_jsonb(NEW) — captures new display_name'
);

-- ---------------------------------------------------------------------------
-- Test 4 — UPDATE of status to 'inactive' writes 'participant.deactivated'
-- ---------------------------------------------------------------------------
UPDATE participants
   SET status = 'inactive'
 WHERE id = (SELECT pid FROM t_pid);

SELECT is(
    (SELECT count(*)::int
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.deactivated'),
    1,
    'UPDATE status→inactive writes exactly one participant.deactivated row'
);

SELECT is(
    (SELECT reason
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.deactivated'),
    'tenant.departure',
    'participant.deactivated reason is "tenant.departure"'
);

SELECT is(
    (SELECT old_value->>'status'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.deactivated'),
    'active',
    'participant.deactivated old_value->>status is "active"'
);

SELECT is(
    (SELECT new_value->>'status'
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
        AND action = 'participant.deactivated'),
    'inactive',
    'participant.deactivated new_value->>status is "inactive"'
);

-- ---------------------------------------------------------------------------
-- Test 5 — Combined UPDATE: role + status→inactive in a single statement.
-- The trigger function uses IF/ELSIF (not multiple IF blocks), so:
--   * Exactly ONE audit row is written for the combined UPDATE.
--   * The status→inactive branch wins (it is the first ELSIF checked).
-- This is the documented behaviour per 0005_audit_triggers.sql lines 13–32.
-- ---------------------------------------------------------------------------
-- Reactivate first (no audit event for status→active alone — that falls
-- through to the OLD IS DISTINCT FROM NEW branch as participant.updated).
UPDATE participants SET status = 'active' WHERE id = (SELECT pid FROM t_pid);

-- Capture audit_log size before the combined UPDATE so we can isolate its delta.
SELECT count(*) AS pre_count
  INTO TEMP TABLE t_pre_combined
  FROM audit_log
 WHERE participant_id = (SELECT pid FROM t_pid);

-- Single statement that mutates BOTH role and status→inactive.
UPDATE participants
   SET role   = 'participant',
       status = 'inactive'
 WHERE id = (SELECT pid FROM t_pid);

SELECT is(
    (SELECT count(*)::int
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)) - (SELECT pre_count::int FROM t_pre_combined),
    1,
    'Combined role+status→inactive UPDATE writes exactly ONE audit row (IF/ELSIF semantics)'
);

SELECT is(
    (SELECT action
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
      ORDER BY id DESC
      LIMIT 1),
    'participant.deactivated',
    'Combined UPDATE: deactivation branch wins over role-change (status check is first ELSIF)'
);

SELECT is(
    (SELECT reason
       FROM audit_log
      WHERE participant_id = (SELECT pid FROM t_pid)
      ORDER BY id DESC
      LIMIT 1),
    'tenant.departure',
    'Combined UPDATE: deactivation row still carries reason="tenant.departure"'
);

SELECT * FROM finish();

ROLLBACK;
