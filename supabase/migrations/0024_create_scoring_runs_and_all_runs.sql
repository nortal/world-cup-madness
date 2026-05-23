-- Migration: scoring_runs telemetry + all_runs view (feature 003, T008)
--
-- Per data-model.md §1.5 + §3. Mirrors feature 002's integration_runs
-- pattern (admin-only RLS land in migration 0029).
--
-- The partial-unique-index mutex is keyed on (action) — per R-4, at-most-
-- one in-flight per scoring action. The only current action that benefits
-- is admin-recalc-all (a long-running RPC); trigger paths don't write
-- scoring_runs rows (they're transactional with the source UPDATE and
-- observability lives in audit_log). Per-action scope future-proofs for
-- additional scoring actions.
--
-- The all_runs view UNIONs integration_runs + scoring_runs for one
-- operator surface. `security_invoker = true` (PG15+ per R-5) applies the
-- underlying admin-only RLS to the view's caller — no separate policy.

CREATE TYPE scoring_action AS ENUM (
    'trigger-result-update',
    'trigger-config-change',
    'trigger-cascade',
    'admin-recalc-all'
);

CREATE TYPE scoring_status AS ENUM (
    'success',
    'error',
    'skipped'
);

CREATE TABLE scoring_runs (
    id                              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    action                          scoring_action   NOT NULL,
    match_id                        UUID             REFERENCES matches(id) ON DELETE SET NULL,
    started_at                      TIMESTAMPTZ      NOT NULL DEFAULT now(),
    finished_at                     TIMESTAMPTZ,
    status                          scoring_status   NOT NULL DEFAULT 'success',
    affected_participants_count     INTEGER          NOT NULL DEFAULT 0,
    error_message                   TEXT,

    CONSTRAINT scoring_runs_match_required_for_per_match_actions
        CHECK (
            (action IN ('trigger-result-update', 'trigger-cascade') AND match_id IS NOT NULL)
            OR
            (action IN ('trigger-config-change', 'admin-recalc-all'))
        ),
    CONSTRAINT scoring_runs_finished_at_after_started_at
        CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT scoring_runs_error_message_for_error_status
        CHECK ((status = 'error') = (error_message IS NOT NULL))
);

-- Per-action mutex: at most one in-flight row per (action).
-- Feature 002's lesson (migration 0018): a Postgres-enforced mutex via
-- partial unique index is the only thing that survives PostgREST sessions.
CREATE UNIQUE INDEX scoring_runs_at_most_one_in_flight_per_action
    ON scoring_runs (action)
    WHERE finished_at IS NULL;

CREATE INDEX scoring_runs_started_at_idx
    ON scoring_runs(started_at DESC);
CREATE INDEX scoring_runs_action_status_started_at_idx
    ON scoring_runs(action, status, started_at DESC);

COMMENT ON TABLE scoring_runs IS
    'feature 003: telemetry for the scoring engine (per-match triggers + admin recalc-all). Partial unique index keyed on (action) provides the at-most-one-in-flight mutex.';

-- ---------------------------------------------------------------------------
-- all_runs view — unified operator surface for sync + scoring telemetry.
-- ---------------------------------------------------------------------------
-- security_invoker=true (PG15+) means the view evaluates in the CALLER's
-- security context. RLS on integration_runs + scoring_runs (admin-only)
-- propagates to anyone querying the view. No separate view policy needed.
-- NOTE: integration_runs.id is BIGSERIAL (bigint); scoring_runs.id is UUID.
-- The view casts both to TEXT so the column types line up across the UNION.
-- match_id is cast to TEXT for the same reason (NULL in the integration row,
-- UUID in the scoring row).
CREATE VIEW all_runs
WITH (security_invoker = true)
AS
SELECT
    'integration'::TEXT       AS run_kind,
    id::TEXT                  AS id,
    action::TEXT              AS action,
    NULL::TEXT                AS match_id,
    started_at,
    finished_at,
    status::TEXT              AS status,
    records_processed         AS affected_count,
    error_message
FROM integration_runs
UNION ALL
SELECT
    'scoring'::TEXT           AS run_kind,
    id::TEXT                  AS id,
    action::TEXT              AS action,
    match_id::TEXT            AS match_id,
    started_at,
    finished_at,
    status::TEXT              AS status,
    affected_participants_count AS affected_count,
    error_message
FROM scoring_runs;

COMMENT ON VIEW all_runs IS
    'feature 003: unified operator telemetry surface over integration_runs + scoring_runs. security_invoker=true applies underlying admin-only RLS.';
