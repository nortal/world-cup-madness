-- pgTAP test: T014 — RLS on `scoring_runs` + `all_runs` view (security_invoker)
--
-- Source migrations:
--   supabase/migrations/0024_create_scoring_runs_and_all_runs.sql  (table + view)
--   supabase/migrations/0029_prediction_rls.sql                    (RLS policy)
-- Spec references:
--   specs/003-predictions-and-scoring/research.md §R-5
--     "all_runs view with security_invoker=true"
--   specs/003-predictions-and-scoring/data-model.md §3, §4.5
-- FR reference: feature 003 telemetry surface (admin-only).
--
-- Goals (in priority order):
--   A. Mirror 007_rls_integration_runs.sql for the sibling `scoring_runs`
--      policy plumbing — admin-only SELECT, no participant writes.
--   B. Verify the `all_runs` view was created WITH (security_invoker = true)
--      so RLS on the two underlying tables propagates to the view's caller.
--   C. End-to-end RLS behaviour: an admin caller sees the UNION of both
--      telemetry tables through the view; a non-admin caller sees neither.
--
-- Assertion 12 ("non-admin sees zero rows through all_runs") is THE headline
-- test for R-5. If it fails, security_invoker is NOT propagating — investigate
-- the WITH clause syntax in migration 0024 first. Without security_invoker, a
-- view runs in its OWNER's context, which (because the owner created the view
-- with privileges on the underlying tables) silently bypasses caller RLS and
-- leaks every scoring/integration row to every authenticated user.
--
-- Test session setup notes:
--   * The test transaction runs as the test session's superuser (postgres),
--     which BYPASSES RLS. To actually exercise the policies we:
--       (i)  SET LOCAL ROLE authenticated for the behavioural sub-blocks; and
--       (ii) populate request.jwt.claims / request.jwt.claim.sub so that
--            auth.uid() inside is_admin_user() resolves to the seeded
--            admin/non-admin participant.
--     RESET ROLE between sub-blocks restores superuser context for the next
--     seed step.
--   * The expected-failure INSERT case is wrapped in a SAVEPOINT so the
--     aborted statement does not poison the outer transaction.

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid       '11111111-1111-1111-1111-111111111111'
-- Admin participant (added to admin_oids; provisioned via provision RPC below)
\set admin_user_id    '21111111-1111-1111-1111-111111111111'
\set admin_oid        '22222222-2222-2222-2222-222222222222'
-- Non-admin eligible participant
\set nonadm_user_id   '31111111-1111-1111-1111-111111111111'
\set nonadm_oid       '33333333-3333-3333-3333-333333333333'

-- ---------------------------------------------------------------------------
-- Helper: populate request.jwt.* GUCs so auth.uid() resolves inside
-- is_admin_user(). Copied verbatim from 003 / 008 (each pgTAP file is
-- self-contained per project convention — there is no shared fixture file).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test_set_jwt(
    p_sub   UUID,
    p_tid   UUID,
    p_oid   UUID,
    p_email TEXT,
    p_name  TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_claims JSONB;
BEGIN
    v_claims := jsonb_build_object(
        'sub',            p_sub::text,
        'email',          p_email,
        'app_metadata',   jsonb_build_object(
                              'tid', p_tid::text,
                              'oid', p_oid::text
                          ),
        'user_metadata',  jsonb_build_object('name', p_name)
    );
    PERFORM set_config('request.jwt.claims',     v_claims::text, true);
    PERFORM set_config('request.jwt.claim.sub',  p_sub::text,    true);
END $$;

-- ---------------------------------------------------------------------------
-- Seed auth.users + tournament_config + two participants (admin + non-admin)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'admin_user_id'),
    (:'nonadm_user_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'admin_user_id'::uuid,  :'admin_oid'::uuid,  'admin@nortal.com',  'Admin User',     'admin',       'active'),
    (:'nonadm_user_id'::uuid, :'nonadm_oid'::uuid, 'player@nortal.com', 'Non-admin User', 'participant', 'active')
ON CONFLICT (oid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed telemetry rows as the test session (superuser bypasses RLS, which is
-- how the service-role / SECURITY DEFINER writes happen in production).
-- One scoring row + one integration row so the UNION view should yield 2.
-- ---------------------------------------------------------------------------
INSERT INTO scoring_runs (
    action, status, started_at, finished_at, affected_participants_count
)
VALUES (
    'admin-recalc-all', 'success', now(), now(), 100
);

INSERT INTO integration_runs (
    provider, action, status, started_at, finished_at, records_processed
)
VALUES (
    'football-data.org', 'bootstrap', 'success', now(), now(), 15
);

-- ===========================================================================
-- A. scoring_runs policy plumbing (mirrors 007_rls_integration_runs.sql)
-- ===========================================================================

-- 1. RLS is enabled on scoring_runs.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.scoring_runs'::regclass
    ),
    TRUE,
    'RLS is enabled on public.scoring_runs'
);

-- 2. Exactly the one expected policy exists.
SELECT policies_are(
    'public',
    'scoring_runs',
    ARRAY['scoring_runs_select_admin'],
    'public.scoring_runs has exactly the one expected RLS policy (scoring_runs_select_admin)'
);

-- 3. The policy applies to SELECT only.
SELECT policy_cmd_is(
    'public', 'scoring_runs', 'scoring_runs_select_admin', 'SELECT',
    'scoring_runs_select_admin applies to SELECT'
);

-- 4. No INSERT/UPDATE/DELETE/ALL policies of any name exist on scoring_runs.
--    Writes flow exclusively through service_role + SECURITY DEFINER triggers.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'scoring_runs'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.scoring_runs has NO INSERT/UPDATE/DELETE/ALL policies (service_role + SECURITY DEFINER writes only)'
);

-- ===========================================================================
-- B. all_runs view storage parameter — security_invoker = true
-- ===========================================================================

-- 5. The view was created WITH (security_invoker = true).
--    pg_class.reloptions is a text[] of "key=value" entries — assert that the
--    literal token 'security_invoker=true' appears in the view's reloptions.
--    This is the structural pre-condition for assertion 12 (the headline R-5
--    behavioural test below). If THIS assertion fails, migration 0024's
--    WITH clause is wrong / missing and 12 will also fail for the same reason.
SELECT ok(
    (
        SELECT 'security_invoker=true' = ANY(reloptions)
        FROM pg_class
        WHERE oid = 'public.all_runs'::regclass
    ),
    'public.all_runs view was created WITH (security_invoker = true)'
);

-- ===========================================================================
-- C. Behavioural RLS through the policy + through the view
-- ===========================================================================
-- Switch to the `authenticated` role for the next assertions so RLS actually
-- engages (superuser bypasses RLS). We set the JWT first so is_admin_user()
-- can resolve auth.uid() to the seeded admin participant row.

-- --- Admin caller --------------------------------------------------------
SELECT test_set_jwt(
    :'admin_user_id'::uuid,
    :'nortal_tid'::uuid,
    :'admin_oid'::uuid,
    'admin@nortal.com'
);
SET LOCAL ROLE authenticated;

-- 6. Admin sees the one seeded scoring_runs row through the table.
SELECT is(
    (SELECT COUNT(*)::int FROM scoring_runs),
    1,
    'Admin (RLS-engaged) SELECT FROM scoring_runs returns the seeded row'
);

-- 7. Admin INSERT into scoring_runs must FAIL — there is no INSERT policy
--    for `authenticated`. Wrap in a SAVEPOINT so the rolled-back INSERT
--    does not poison the outer transaction's plan count.
SAVEPOINT before_admin_insert;
SELECT throws_ok(
    $$INSERT INTO scoring_runs (action, status, affected_participants_count)
      VALUES ('admin-recalc-all', 'success', 0)$$,
    '42501',  -- insufficient_privilege (RLS violation surfaces as this SQLSTATE)
    NULL,
    'Admin (RLS-engaged) INSERT INTO scoring_runs raises insufficient_privilege (no INSERT policy)'
);
ROLLBACK TO SAVEPOINT before_admin_insert;

-- 8. Admin sees BOTH rows through the all_runs view (1 integration + 1 scoring).
SELECT is(
    (SELECT COUNT(*)::int FROM all_runs),
    2,
    'Admin SELECT FROM all_runs returns 2 rows (UNION of integration + scoring)'
);

-- 9. Of the 2 rows, exactly one is the integration row.
SELECT is(
    (SELECT COUNT(*)::int FROM all_runs WHERE run_kind = 'integration'),
    1,
    'Admin sees exactly one all_runs row with run_kind = integration'
);

-- 10. Of the 2 rows, exactly one is the scoring row.
SELECT is(
    (SELECT COUNT(*)::int FROM all_runs WHERE run_kind = 'scoring'),
    1,
    'Admin sees exactly one all_runs row with run_kind = scoring'
);

RESET ROLE;

-- --- Non-admin caller ----------------------------------------------------
SELECT test_set_jwt(
    :'nonadm_user_id'::uuid,
    :'nortal_tid'::uuid,
    :'nonadm_oid'::uuid,
    'player@nortal.com'
);
SET LOCAL ROLE authenticated;

-- 11. Non-admin sees ZERO rows in scoring_runs (admin-only SELECT policy filters).
SELECT is(
    (SELECT COUNT(*)::int FROM scoring_runs),
    0,
    'Non-admin (RLS-engaged) SELECT FROM scoring_runs returns 0 rows (admin-only policy)'
);

-- 12. HEADLINE ASSERTION (R-5).
--     Non-admin sees ZERO rows through the all_runs view. This is the
--     load-bearing test that `security_invoker = true` is propagating the
--     underlying admin-only RLS to the view's caller. If this returns >0,
--     the view is silently bypassing RLS (running in owner context) and
--     leaking every scoring + integration telemetry row to every
--     authenticated user. See R-5 + assertion 5 above for the structural
--     pre-condition.
SELECT is(
    (SELECT COUNT(*)::int FROM all_runs),
    0,
    'HEADLINE (R-5): Non-admin SELECT FROM all_runs returns 0 rows (security_invoker propagates underlying RLS)'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
