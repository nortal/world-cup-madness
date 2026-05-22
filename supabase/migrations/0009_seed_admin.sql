-- Migration: seed singleton tournament_config row

-- TODO: replace nortal_tenant_id with real Nortal tenant ID for prod via separate seed/env script
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, '00000000-0000-0000-0000-000000000000'::uuid, ARRAY[]::uuid[])
ON CONFLICT (id) DO NOTHING;
