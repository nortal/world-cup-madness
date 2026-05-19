# Phase 0 Research: Authentication and Participant Provisioning

**Feature**: 001-authentication-and-participant
**Date**: 2026-05-15
**Status**: Complete — all NEEDS CLARIFICATION items in Technical Context resolved

This document resolves the unknowns surfaced in `plan.md`'s Technical Context. Each item: **Decision** → **Rationale** → **Alternatives considered** → **Source**.

---

## R-1: i18n library choice for trilingual UI (en / es / pt-BR)

**Decision**: `next-intl` (latest stable, v3+).

**Rationale**: First-class Next.js 15 App Router support including Server Components; built-in middleware for `Accept-Language` detection (NFR-A5); JSON message catalogs play nicely with code review and translation tooling; small runtime footprint compared to alternatives.

**Alternatives considered**:
- `next-i18next` — older library; App Router support was added later and feels bolted on. Heavier runtime.
- Lingui — powerful (compile-time message extraction with ICU formatting) but adds build-tooling complexity not justified for our small initial vocabulary.
- Build custom — rejected; reinvents wheel.

**Source**: Manual research; Next.js + i18n industry consensus 2025–2026.

---

## R-2: Microsoft OAuth provider setup in Supabase Auth

**Decision**: Use Supabase Auth's built-in Azure (Microsoft) provider configured via `supabase/config.toml` for local dev and via Supabase Studio for production. Required env vars:
- `AUTH_AZURE_CLIENT_ID` — Microsoft Entra app registration client ID (from Nortal IT per FA-1)
- `AUTH_AZURE_SECRET` — corresponding client secret
- Tenant configured at OAuth-provider level: **`common` (multi-tenant)** so the Microsoft sign-in dialog accepts any account, then we validate `tid` ourselves
- Callback URL: `https://{vercel-domain}/auth/callback` (production) or `http://localhost:3000/auth/callback` (dev)
- Scopes: `openid email profile`

The Nortal-tenant restriction is enforced **inside our app** (RLS + provisioning function), not at the OAuth provider level. This is intentional so ineligible users get the auditable `/access-denied` flow with our message — not Microsoft's generic page (per ADR-011 + FR-A7).

**Rationale**: Out-of-the-box provider; no custom middleware needed; we get the `tid` claim in the JWT for free. Multi-tenant OAuth config is necessary because if we restrict at the provider, Microsoft refuses external accounts with its own UI before our app sees them — which contradicts FR-A7's app-controlled rejection requirement.

**Alternatives considered**:
- Restrict at the Microsoft side (`tenant_id={nortal-tenant-id}`) — rejected; produces Microsoft's generic error UI, no audit trail in our system.
- Custom OAuth handler bypassing Supabase Auth — rejected; reimplements established Supabase patterns.

**Source**: Supabase Auth Azure provider documentation; Microsoft identity platform documentation.

---

## R-3: JWT custom-claim access from RLS policies

**Decision**: Access JWT claims in Postgres RLS using:
- `auth.jwt() ->> 'tid'` for tenant ID (custom claim mapped from Microsoft JWT via Supabase Auth hook)
- `auth.jwt() -> 'app_metadata' ->> 'oid'` for Microsoft object ID
- `auth.uid()` for the Supabase user UUID (joins to `participants.auth_user_id`)

Microsoft's JWT claims (`tid`, `oid`, `name`, `email`) are forwarded into Supabase Auth's session JWT via a Supabase Auth hook (`before-issue-token`) that copies the relevant claims from `provider_token` into our session JWT's `app_metadata`. The hook lives at `supabase/auth-hooks/before-issue-token.ts`.

**Rationale**: Standard Supabase pattern. `app_metadata` is the recommended namespace for trusted server-set claims (the `user_metadata` namespace is user-writable and not safe for authorization). The hook approach is cleaner than re-decoding the original Microsoft token in every RLS policy.

**Alternatives considered**:
- Decode raw provider token in RLS — rejected; provider token may not be available in every session context (refresh, server-side calls).
- Store tenant ID + oid in `participants` row only and JOIN — rejected; defeats per-request RLS check (the row exists if you've ever been provisioned, but doesn't fail when tenant membership is revoked mid-session).

**Source**: Supabase Auth documentation on JWT claims and Auth hooks.

---

## R-4: Email normalization in Postgres

**Decision**: Use the `citext` extension for `participants.email` plus a Postgres BEFORE INSERT/UPDATE trigger that explicitly trims whitespace.

**Rationale**: `citext` provides case-insensitive comparison automatically (the UNIQUE constraint becomes case-insensitive without a functional index). The trim trigger handles whitespace explicitly (citext does NOT trim). Together: simplest, most idiomatic Postgres approach for canonical email storage per spec C5.

**Alternatives considered**:
- UNIQUE on `LOWER(email)` functional index with `text` column — works but every query must remember to use `LOWER()` for index usage; easy to forget.
- Trigger-only (lowercase + trim on insert) — works but error-prone if any code path bypasses the trigger.
- Application-side normalization only — rejected; database can't enforce canonical form; race condition risk on concurrent inserts.

**Source**: PostgreSQL `citext` extension documentation; community best practices.

---

## R-5: Audit trigger pattern for nullable `participant_id`

**Decision**:
- **Participant lifecycle events** (`participant.created` / `updated` / `deactivated` / `role-changed`): `AFTER INSERT/UPDATE` triggers on `participants` table writing to `audit_log` with `participant_id = NEW.id`
- **Auth-failure events** (`auth.rejected` / `auth.provider-error`): explicitly written via the `record_auth_failure(...)` SECURITY DEFINER RPC since these events have no triggering row to attach to

**Rationale**: Trigger-based for participant lifecycle ensures we can never forget to audit. Function-based for auth failures because they're unattached events (no participant row exists). Single `audit_log` table; same `actor_oid` / `actor_email` columns; single admin-search surface (per ADR-010).

**Alternatives considered**:
- All-trigger via a "ghost" insert into a phantom table — too clever, hard to read.
- Application-code logging via Supabase JS — rejected; too easy to skip; loses transactional consistency with the row mutation.

**Source**: ADR-010 (this session); PostgreSQL trigger documentation.

---

## R-6: Welcome-dismissed update pattern

**Decision**: A SECURITY DEFINER RPC function `dismiss_welcome()` that:
1. Identifies the calling participant via `auth.uid()`
2. Sets `welcome_dismissed_at = COALESCE(welcome_dismissed_at, now())` — idempotent on the participant row
3. Triggers the standard `participants` AFTER UPDATE trigger (action `participant.updated`)

**Rationale**: Centralised logic. Client code calls `supabase.rpc('dismiss_welcome')` without needing UPDATE permission on the participants table directly. Audit trail captured via the standard trigger. Idempotent — re-calling on an already-dismissed participant is a no-op (preserves the original timestamp).

**Alternatives considered**:
- Direct `UPDATE participants SET welcome_dismissed_at = now() WHERE id = auth.uid()` from the client — works but requires UPDATE RLS policy on participants for that column; mixes auth-user updates with our internal mutation.
- Separate `welcome_dismissals` table with INSERT — overkill for a one-shot timestamp.

**Source**: ADR-010 (single audit_log convention); Supabase RPC patterns.

---

## R-7: Playwright + Supabase local-stack pattern

**Decision**:
- Local Supabase stack via `supabase start` (Docker-backed) for E2E tests.
- For auth-gated flows: use the Supabase **admin API** (`auth.admin.createUser` / `updateUserById`) to seed an `auth.users` row carrying the desired claims in `raw_app_meta_data` (`tid`, `oid`, `provider`) and `raw_user_meta_data` (`name`, `full_name`). The page-side Supabase client then signs in via `auth.signInWithPassword` against a fixed local-only password. Real session cookies are written by `@supabase/ssr`, exercising the full app stack identically to the production OAuth callback.
- pgTAP for RLS / SECURITY DEFINER function tests; runs via `supabase db test` against the local stack.

**Why not `signInWithIdToken`**: the original plan was to forge a Microsoft-shaped ID token and pass it to `supabase.auth.signInWithIdToken({ provider: 'azure', token })`. That does NOT work — Supabase Auth (GoTrue) performs real OIDC discovery against the configured `auth.external.azure.url` and validates the token's signature against Microsoft's JWKS. A forged token cannot pass that check, even locally. (See migration `0010_fix_jwt_claim_reads.sql` for the follow-up: RPC + RLS predicate now read custom claims from `app_metadata`, aligning the data layer with the admin-API seed path.)

**Rationale**: fully-local test stack means no real Microsoft Entra dependency for CI. Admin-API seeding is faster and more deterministic than driving Microsoft OAuth's UI, and unlike `signInWithIdToken` it actually works against the local GoTrue instance. pgTAP runs at the data layer where the auth boundary actually lives — the right place for RLS policy tests.

**Alternatives considered**:
- Real Microsoft OAuth in tests — slow, flaky, requires a dedicated test tenant.
- Mock the entire Supabase client at the Next.js level — defeats the integration purpose; misses RLS bugs.
- Hand-mint Supabase access tokens via `JWT_SECRET` + `setSession` — works, but duplicates Supabase's session minting and loses validation against GoTrue's expected JWT shape.

**Source**: Supabase local-development docs; Supabase admin API reference; Playwright testing patterns; pgTAP project.

---

## Constitution Re-check (post-research)

After resolving research items, no new constitution violations introduced. All choices align with:
- `constitution.md` §1.1 (DB-enforced rules) — RLS + functions remain the authoritative layer
- `constitution-frontend.md` §IX (no `service_role` in client) — `next-intl` and `@supabase/ssr` are both client-safe
- `constitution-backend.md` §V.3 (no ORM) — direct Postgres + generated types preserved

**All NEEDS CLARIFICATION items resolved.** Proceeding to Phase 1.
