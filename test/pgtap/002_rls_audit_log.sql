-- pgTAP test: T019 — RLS on `audit_log`
--
-- Source migration: supabase/migrations/0008_rls_policies.sql
-- Spec: specs/001-authentication-and-participant/data-model.md §"Row-Level Security Policies → audit_log"
--
-- Goal: verify that `audit_log` is tamper-resistant from end-user roles:
--   1. RLS is enabled on the table
--   2. Exactly one policy exists on the table
--   3. That policy is named `audit_log_admin_select` and applies to SELECT only
--   4. The policy's USING predicate restricts visibility to active admin Nortal users
--   5. There are zero policies on `audit_log` for INSERT / UPDATE / DELETE
--      (mutations happen only via SECURITY DEFINER functions/triggers)

BEGIN;

SELECT plan(7);

-- 1. RLS enabled on audit_log
SELECT is(
    (SELECT relrowsecurity
       FROM pg_class
      WHERE oid = 'public.audit_log'::regclass),
    true,
    'RLS is enabled on public.audit_log'
);

-- 2. Exactly one policy exists on audit_log
SELECT is(
    (SELECT count(*)::int
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'audit_log'),
    1,
    'audit_log has exactly one policy (admin-only SELECT)'
);

-- 3. The single policy is named `audit_log_admin_select` and is a SELECT policy
SELECT policies_are(
    'public',
    'audit_log',
    ARRAY['audit_log_admin_select'],
    'audit_log defines only the audit_log_admin_select policy'
);

SELECT is(
    (SELECT cmd
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'audit_log'
        AND policyname = 'audit_log_admin_select'),
    'SELECT',
    'audit_log_admin_select policy applies to SELECT only'
);

-- 4a. Policy targets the `authenticated` role
SELECT policy_roles_are(
    'public',
    'audit_log',
    'audit_log_admin_select',
    ARRAY['authenticated'],
    'audit_log_admin_select policy applies to the authenticated role'
);

-- 4b. Policy USING predicate references the eligibility predicate AND an
--     admin-role check on the participants table (per 0008_rls_policies.sql)
SELECT ok(
    (SELECT qual
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'audit_log'
        AND policyname = 'audit_log_admin_select')
    LIKE '%is_eligible_nortal_user()%'
    AND
    (SELECT qual
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'audit_log'
        AND policyname = 'audit_log_admin_select')
    LIKE '%role%=%admin%',
    'audit_log_admin_select USING clause checks is_eligible_nortal_user() and admin role'
);

-- 5. No INSERT / UPDATE / DELETE policies exist on audit_log
--    (tamper-resistant: mutations only via SECURITY DEFINER paths)
SELECT is(
    (SELECT count(*)::int
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'audit_log'
        AND cmd <> 'SELECT'),
    0,
    'audit_log has no INSERT/UPDATE/DELETE policies (tamper-resistant)'
);

SELECT * FROM finish();

ROLLBACK;
