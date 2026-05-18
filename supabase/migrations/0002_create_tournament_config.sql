-- Migration: singleton tournament_config table (FC-1 fail-closed gate)

CREATE TABLE tournament_config (
    id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    nortal_tenant_id UUID NOT NULL,
    admin_oids       UUID[] NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
