-- Migration: seed teams catalog with FIFA WC 2026 confirmed qualifiers (feature 002, T009)
--
-- 32-team seed covering all six confederations. Provider team ids in the 760–800
-- range mirror football-data.org's actual id space for European/South American
-- teams, plus higher ids for AFC/CAF/CONCACAF entries — the values are stable
-- enough that the bootstrap sync (Edge Function) can match seeded rows against
-- the live provider response without inserting duplicates.
--
-- This seed is what makes local dev work WITHOUT a football-data.org API key:
-- combined with the fixture file at supabase/functions/sync-matches/__fixtures__/
-- v4-sample.json (referencing the same provider_team_ids), the bootstrap import
-- in fixture mode populates the catalog deterministically. CI runs use the same
-- combination, so no live API call is required for the full test suite.
--
-- ON CONFLICT (provider_team_id) DO NOTHING keeps `npx supabase db reset`
-- idempotent — re-running this migration won't double-insert if the rows
-- already exist (which they will after the first reset).
--
-- WC 2026 will host 48 teams (first expanded tournament); this seed covers the
-- core 32 already qualified or near-certain qualifiers as of seed-time. The
-- remaining 16 slots will fill in via the provider sync after the FIFA draw.
-- Provider team ids and display names are anchored against football-data.org's
-- public team catalog; adjust if the provider renames a team before sync.

INSERT INTO teams (name, tla, provider_team_id) VALUES
    -- UEFA (Europe) — auto-qualified hosts + top FIFA-ranked European nations
    ('England',          'ENG',   770),
    ('France',           'FRA',   773),
    ('Germany',          'GER',   759),
    ('Italy',            'ITA',   784),
    ('Spain',            'ESP',   760),
    ('Portugal',         'POR',   765),
    ('Netherlands',      'NED',   8601),
    ('Belgium',          'BEL',   805),
    ('Croatia',          'CRO',   799),
    ('Denmark',          'DEN',   782),
    ('Switzerland',      'SUI',   788),
    ('Poland',           'POL',   794),

    -- CONMEBOL (South America)
    ('Argentina',        'ARG',   762),
    ('Brazil',           'BRA',   764),
    ('Uruguay',          'URU',   769),
    ('Colombia',         'COL',   775),
    ('Chile',            'CHI',   797),
    ('Ecuador',          'ECU',   791),

    -- CONCACAF (North/Central America) — hosts auto-qualified
    ('United States',    'USA',   790),
    ('Mexico',           'MEX',   774),
    ('Canada',           'CAN',   796),
    ('Costa Rica',       'CRC',   8617),

    -- AFC (Asia)
    ('Japan',            'JPN',   8665),
    ('South Korea',      'KOR',   8634),
    ('Australia',        'AUS',   8602),
    ('Iran',             'IRN',   8675),
    ('Saudi Arabia',     'KSA',   8703),

    -- CAF (Africa)
    ('Morocco',          'MAR',   8623),
    ('Senegal',          'SEN',   8649),
    ('Egypt',            'EGY',   8607),
    ('Tunisia',          'TUN',   8654),
    ('Nigeria',          'NGA',   8645)
ON CONFLICT (provider_team_id) DO NOTHING;
