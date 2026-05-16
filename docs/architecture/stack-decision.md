# Stack Decision (ADR)

**Status:** Approved 2026-05-15.
**Resolves:** [OD-007](open-decisions.md#od-007--implementation-approach) (Implementation approach).
**Related:** [OD-001](open-decisions.md#od-001--approved-email-domains) — eligibility validated via Entra ID tenant claim (`tid`), not email domain alone.
**Last updated:** 2026-05-15

> **Approval notes.** Stack approved as proposed below. Sub-conditions tracked as Phase 1 follow-ups:
> (1) Nortal Security signoff on OAuth + tenant-allowlist;
> (2) Entra ID tenant integration spike;
> (3) Supabase Pro-tier budget approval for tournament window (June–July 2026);
> (4) Architecture board minute (if governance requires).

## Proposed stack

| Layer | Choice |
|---|---|
| Frontend framework | **Next.js (App Router)** with React + TypeScript |
| Styling | **Tailwind CSS** |
| Frontend host | **Vercel** (free tier viable for initial development) |
| Backend (data + API + auth) | **Supabase** — Postgres, PostgREST auto-API, Auth, Realtime, Edge Functions |
| Identity | **Supabase Auth with Microsoft/Azure OAuth** provider (no SAML required on free tier) |
| Domain enforcement | Postgres trigger + Row-Level Security on a `participants` table, validating email domain against an allowlist (FR-001, FR-002) |
| Authorization | **Row-Level Security (RLS)** policies in Postgres |
| External data | **football-data.org** (or equivalent) consumed via Supabase Edge Function on a schedule (FR-017) |
| Secrets at runtime | **Vercel environment variables** + **Supabase project secrets** (template's age-encryption infra retained for any local secrets/scripts) |

## Rationale

The Nortal doc §3 mandates technology neutrality and §8.3 lists three candidate patterns (custom web app / enterprise low-code / managed pool platform). For an internal pool of likely a few hundred Nortal employees with strict access rules and a transparent audit story, the **custom-web-app pattern** wins on:

- **Domain restriction (FR-001/FR-002)** is enforceable at the database layer via RLS rather than trusted entirely to application code.
- **Time locking (FR-007/FR-008/FR-010)** maps cleanly to RLS policies using `now()` — server-side trusted time, exactly BR-LOCK-001.
- **Audit trail (FR-018)** is one `AFTER INSERT/UPDATE` trigger per audited table writing to an `audit_log` table.
- **Realtime leaderboard (FR-013)** uses Supabase Realtime — no polling required.
- **Provider abstraction (FR-017)** lives in an Edge Function that holds the football-data.org API key and writes normalized rows to Supabase.

Managed pool platforms were rejected because they generally cannot meet FR-001/FR-002 (corporate domain restriction), FR-018 (auditability), and the privacy/data-minimization requirements in §11.

## Why this maps well to the doc's architecture diagram (Figure 1)

| §8.2 component | Implementation |
|---|---|
| Participant Experience | Next.js + Tailwind on Vercel |
| Administrator Experience | Same Next.js app, role-gated routes |
| Corporate Identity Boundary | Microsoft/Azure OAuth via Supabase Auth |
| Application / API Boundary | Supabase auto-generated REST (PostgREST) + RPC functions + Edge Functions |
| Business Rules Layer | Postgres functions (`calculate_match_points()`, `lock_prediction()`) + RLS policies |
| Prediction Management | Supabase tables: `predictions`, `final_predictions` |
| Tournament Data Management | Supabase tables: `matches`, `teams`, `players`, `tournament_config` |
| Leaderboard & Analytics | Postgres materialized views + Supabase Realtime |
| Transactional Data Store | Supabase Postgres |
| Integration Layer | Supabase Edge Function calling football-data.org |
| Observability & Operations | Supabase logs + Vercel logs + structured app logs |
| Governance Controls | RLS policies + audit triggers + admin-only RPC functions |
| Notification & Engagement Layer | Edge Function + (channel TBD — see [OD-008](open-decisions.md#od-008--notification-channels)) |

## Cost profile

| Phase | Supabase | Vercel | Total |
|---|---|---|---|
| Development / pre-launch | Free tier | Free tier | **$0/mo** |
| During tournament (recommended) | Pro tier ($25/mo) for 99.9% SLA, daily backups, no inactivity-pause | Free tier likely sufficient | **~$25/mo** |
| Post-tournament archive | Free tier | Free tier | **$0/mo** |

## Tradeoffs and risks

| Concern | Detail | Mitigation |
|---|---|---|
| **SAML SSO is paid-tier on Supabase** | $599/mo (Team plan) for true SAML. If Nortal mandates SAML rather than OAuth, free tier is not viable. | Use Azure **OAuth** provider on free tier + domain-allowlist via trigger/RLS. Validate with Nortal security ([OD-001](open-decisions.md#od-001--approved-email-domains)). |
| **`service_role` key bypasses RLS** | If leaked or accidentally shipped to the browser, all locks/audit can be bypassed. | Keep service_role key in Vercel server-side env vars only; use sparingly in Edge Functions; never in client bundles. Audit every usage. |
| **Free-tier projects pause after 1 week of inactivity** | Could affect pre-launch idle periods. | Upgrade to Pro tier during the tournament window ($25/mo). |
| **Vendor lock-in (moderate)** | Postgres is portable; RLS, Auth, Edge Functions, Realtime are Supabase-shaped. | Acceptable given the project lifespan (~one tournament). Schema and data migrate cleanly to plain Postgres if needed. |
| **NFR-001 availability during match windows** | Free tier has no SLA. | Pro tier gives 99.9% SLA. |
| **Operational maturity** | The team needs comfort with SQL, RLS, Postgres triggers. | Pair with someone fluent if absent; alternatively choose the enterprise low-code pattern (slower to build, less power). |

## What this decision does not commit to

- **Notification channel** (Slack / Teams / email / in-app) — [OD-008](open-decisions.md#od-008--notification-channels)
- **Football data provider** — football-data.org is the example in the doc, not a commitment. The integration layer (§10.2) is provider-agnostic.
- **Localization** — NFR-010 mentions English/Spanish; not in MVP scope.
- **Engagement enhancements** (§14.2: completeness meter, badges, team leagues, etc.) — MVP vs v2 scope to be decided.

## Phase 1 follow-ups (OD-007 sub-conditions)

OD-007 is closed; the items below are tracked as Phase 1 work and do not block scaffolding:

1. **Security review** — Nortal Security signoff on the OAuth + Entra-tenant-allowlist approach for FR-001/FR-002. Required before Phase 1 production cutover.
2. **Entra ID tenant integration spike** — verify Microsoft/Azure OAuth provider works with Nortal's Entra tenant ID; obtain the tenant `tid` value from Nortal IT for the trigger/RLS check (per OD-001 resolution).
3. **Pro-tier budget** — approve the $25/mo Supabase Pro-tier upgrade for the tournament window (June–July 2026); needed before Phase 5 operational readiness for the 99.9% SLA (NFR-001).
4. **Architecture board minute** — if Nortal governance requires a formal minute, capture this ADR's approval in the appropriate system.
