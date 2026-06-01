-- Migration: audit_participants_changes() trigger function + AFTER triggers

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
