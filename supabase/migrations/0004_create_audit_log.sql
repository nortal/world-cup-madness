-- Migration: tamper-resistant audit_log (ADR-010)

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
    attempted_tid   UUID,
    reason          TEXT
);

CREATE INDEX audit_log_occurred_at_idx ON audit_log(occurred_at DESC);
CREATE INDEX audit_log_action_idx       ON audit_log(action);
CREATE INDEX audit_log_actor_oid_idx    ON audit_log(actor_oid);
CREATE INDEX audit_log_participant_id_idx
    ON audit_log(participant_id) WHERE participant_id IS NOT NULL;
