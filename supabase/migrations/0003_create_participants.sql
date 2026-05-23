-- Migration: participants table with citext email, indexes, and email-trim trigger

CREATE TABLE participants (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id          UUID NOT NULL UNIQUE
                              REFERENCES auth.users(id) ON DELETE RESTRICT,
    oid                   UUID NOT NULL UNIQUE,
    email                 CITEXT NOT NULL UNIQUE,
    display_name          TEXT NOT NULL,
    role                  TEXT NOT NULL DEFAULT 'participant'
                              CHECK (role IN ('participant', 'admin')),
    status                TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at         TIMESTAMPTZ,
    welcome_dismissed_at  TIMESTAMPTZ
);

CREATE INDEX participants_oid_idx ON participants(oid);
CREATE INDEX participants_role_active_idx ON participants(role) WHERE status = 'active';

CREATE OR REPLACE FUNCTION trim_participant_email()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.email := trim(NEW.email::text)::citext;
    RETURN NEW;
END $$;

CREATE TRIGGER trim_email_before_insert_or_update
    BEFORE INSERT OR UPDATE OF email ON participants
    FOR EACH ROW EXECUTE FUNCTION trim_participant_email();
