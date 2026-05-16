# Implementation Plan: Authentication and Participant Provisioning (001)

**Branch**: `001-authentication-and-participant`
**Date**: 2026-05-15
**Spec**: [spec.md](./spec.md)
**Status**: Phase 0 + Phase 1 design complete; ready for `/ai1st-dev-tasks`

## Summary

Implement the auth boundary for World Cup Madness: Microsoft OAuth via Supabase Auth, automatic participant provisioning from JWT claims, per-request tenant eligibility re-validation via Postgres RLS, soft-deactivation on tenant departure, and trilingual public surfaces (en / es / pt-BR) for landing, sign-in, `/access-denied`, `/auth-error`, `/privacy`, profile, and the welcome modal. All authoritative logic lives at the database layer; the Next.js layer is a presentation shell over PostgREST + a small set of SECURITY DEFINER RPC functions.

---

## Implementation Conflicts

**Status**: No Conflicts Found
**Conflict Check Date**: 2026-05-15
**Checked Against**: This is the first feature spec; no other UC-XX or EN-XX implementation plans exist.

---

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js + Edge Functions); PostgreSQL 15+ (database, RLS policies, SECURITY DEFINER functions)
**Primary Dependencies**: Next.js 15 (App Router), React 19, `@supabase/ssr` (Server Component cookie handling), `@supabase/supabase-js`, `next-intl` (i18n per ADR-008), Tailwind CSS 4.x
**Storage**: PostgreSQL 15+ (Supabase-managed); `citext` extension for case-insensitive email column
**Testing**: Jest + React Testing Library (unit / component); Playwright (E2E + accessibility); pgTAP (RLS + SECURITY DEFINER function tests)
**Target Platform**: Vercel (frontend); Supabase Cloud (Postgres + Auth + Edge Functions). Pro tier during tournament window.
**Project Type**: web
**Performance Goals**: NFR-A1 — RLS overhead ≤ 10 ms per query; NFR-A2 — OAuth round-trip (sign-in click → dashboard) ≤ 3 s, excluding Microsoft pages
**Constraints**: Per-request RLS validation on JWT `tid` claim; fail-closed if `nortal_tenant_id` config missing; `service_role` never in client bundles; trilingual launch (en / es / pt-BR)
**Scale/Scope**: < 10,000 active Nortal participants (FA-3)

---

## Constitution Check

*GATE: Must pass before Phase 0. Re-evaluated after Phase 1 design — passes.*

**Applicable Constitution**: Frontend + Backend + Universal (cross-cutting feature)
**Source Documents**:
- `../.ai_project_memory/constitution.md` (universal)
- `../.ai_project_memory/constitution-frontend.md` (Next.js stack)
- `../.ai_project_memory/constitution-backend.md` (Supabase stack)

### Compliance Checklist

#### Universal (`constitution.md`)
- [x] **1.1**: Modular monolith with DB-enforced rules — eligibility, role evaluation, audit logging all live at DB layer (RLS + Postgres SECURITY DEFINER functions). Next.js never owns auth decisions.
- [x] **1.2**: Naming conventions — kebab-case files, PascalCase React components, camelCase TS variables, snake_case SQL columns and functions
- [x] **1.3**: No silent failures — provisioning function returns explicit `outcome` field; auth failures audited; structured logging from Edge Functions
- [x] **2.0**: No secrets in code — Vercel env vars + Supabase project secrets; no `service_role` in client; eligibility at DB layer (Postgres trigger + RLS), satisfying central FR-A1 requirement

#### Frontend (`constitution-frontend.md`)
- [x] **IV.1**: Server Components by default — `"use client"` only for the welcome modal, profile-edit form, sign-in button, and retry button on `/auth-error`
- [x] **VI.1**: TypeScript strict mode; Tailwind utilities only (no inline styles); component composition (small, composable)
- [x] **IX**: No `service_role` in client bundles; no RLS bypass; sign-in state lives in Supabase session cookie (not localStorage)

#### Backend (`constitution-backend.md`)
- [x] **IV.1**: All writes via PostgREST or RPC — RPC functions: `provision_participant_from_jwt()`, `update_display_name()`, `dismiss_welcome()`, `record_auth_failure()`. No manual route handlers for CRUD.
- [x] **V.3**: No ORM — direct Postgres via Supabase client + generated types
- [x] **VI.1**: `service_role` used only in server-side cookies handler and Edge Functions; never in browser client
- [x] **VI.2**: Tenant eligibility validated at DB layer — Postgres function `is_eligible_nortal_user()` is the reusable predicate used by every RLS policy on participant-scoped data
- [x] **VIII.2**: pgTAP planned for RLS + function tests (see `test/pgtap/`)

**Violations Found**: None
**Remediation**: N/A — see [Complexity Tracking](#complexity-tracking) section (empty).

---

## Project Structure

### Documentation (this feature)

```
specs/001-authentication-and-participant/
├── spec.md                            # Feature specification (po-specify + po-clarify)
├── plan.md                            # This file
├── research.md                        # Phase 0 output — resolved unknowns
├── data-model.md                      # Phase 1 output — tables, RLS, functions
├── contracts/                         # Phase 1 output
│   ├── README.md                      # PostgREST + RPC contract overview
│   ├── rpc-provision-participant.md
│   ├── rpc-update-display-name.md
│   ├── rpc-dismiss-welcome.md
│   └── rpc-record-auth-failure.md
├── quickstart.md                      # Local dev setup + verification
├── checklists/
│   └── requirements.md                # Spec quality checklist
└── tasks.md                           # Phase 2 output (created by /ai1st-dev-tasks)
```

### Source Code (repository root)

```
project-repos/world-cup-madness/
├── app/                                       # Next.js App Router
│   ├── (public)/                              # NEW route group — unauthenticated surfaces
│   │   ├── page.tsx                           # Landing page (sign-in CTA, privacy link)
│   │   ├── access-denied/page.tsx             # FR-A7
│   │   ├── auth-error/page.tsx                # FR-A9 (Retry CTA)
│   │   └── privacy/page.tsx                   # FR-A10
│   ├── (participant)/                         # Existing route group (per FE constitution §III)
│   │   ├── dashboard/page.tsx                 # Post-auth landing; welcome-modal trigger
│   │   └── profile/page.tsx                   # FR-A2 (display-name editing)
│   ├── auth/
│   │   ├── callback/route.ts                  # Supabase OAuth callback handler
│   │   └── sign-out/route.ts                  # Sign-out endpoint
│   └── layout.tsx
├── components/
│   ├── auth/
│   │   ├── SignInButton.tsx                   # Client component
│   │   ├── WelcomeModal.tsx                   # Client component (NFR-A4 a11y)
│   │   └── PrivacyLink.tsx
│   └── ui/
├── lib/
│   ├── supabase/
│   │   ├── server.ts                          # Server Component client (@supabase/ssr)
│   │   ├── client.ts                          # Browser client
│   │   ├── middleware.ts                      # Session-refresh middleware helper
│   │   └── database.types.ts                  # Generated
│   └── i18n/
│       ├── messages/
│       │   ├── en.json
│       │   ├── es.json
│       │   └── pt-BR.json
│       └── config.ts                          # next-intl config (Accept-Language)
├── middleware.ts                              # next-intl + Supabase session refresh
├── supabase/
│   ├── migrations/
│   │   ├── 0001_extensions.sql                # CREATE EXTENSION citext
│   │   ├── 0002_create_tournament_config.sql  # singleton config
│   │   ├── 0003_create_participants.sql       # table + trim trigger
│   │   ├── 0004_create_audit_log.sql          # nullable participant_id
│   │   ├── 0005_audit_triggers.sql            # AFTER INSERT/UPDATE on participants
│   │   ├── 0006_provision_function.sql        # provision_participant_from_jwt()
│   │   ├── 0007_profile_functions.sql         # update_display_name(), dismiss_welcome()
│   │   ├── 0008_rls_policies.sql              # RLS + is_eligible_nortal_user() helper + view
│   │   └── 0009_seed_admin.sql                # Seed config (env-driven)
│   ├── auth-hooks/                            # NEW — JWT custom claim mapping
│   │   └── before-issue-token.ts              # Copies tid+oid into app_metadata
│   └── seed.sql
├── e2e/
│   └── tests/
│       ├── auth-eligible-new-user.spec.ts     # TC-1
│       ├── auth-eligible-returning.spec.ts    # TC-2
│       ├── auth-admin-role.spec.ts            # TC-3
│       ├── profile-edit-display-name.spec.ts  # TC-4
│       ├── auth-ineligible-rejection.spec.ts  # TC-5
│       ├── auth-tenant-departure.spec.ts      # TC-6
│       ├── auth-per-request-rls.spec.ts       # TC-7
│       ├── audit-search-auth-failures.spec.ts # TC-8
│       ├── auth-role-downgrade.spec.ts        # TC-9
│       ├── auth-provider-error.spec.ts        # TC-10
│       ├── privacy-notice-reachable.spec.ts   # TC-11
│       ├── welcome-modal-cross-device.spec.ts # TC-12
│       ├── email-case-insensitive.spec.ts     # TC-13
│       └── i18n-locale-detection.spec.ts      # NFR-A5
└── test/
    └── pgtap/                                 # NEW — SQL-level RLS + function tests
        ├── 001_rls_participants.sql
        ├── 002_rls_audit_log.sql
        ├── 003_provision_function.sql
        ├── 004_email_normalization.sql
        └── 005_audit_trigger.sql
```

**Structure Decision**: Web application — Next.js App Router (frontend) + Supabase (backend). Reuses the established structure from `constitution-frontend.md` §III and `constitution-backend.md` §III, adding for this feature: a new `(public)/` route group for unauthenticated surfaces, an `auth/callback/` handler, the `(participant)/profile/` page, an `i18n/` setup with three message catalogs, the first batch of Supabase migrations + RLS test suite, and a new `auth-hooks/` directory for JWT claim mapping.

---

## Phase 0: Outline & Research

See [research.md](./research.md). 7 unknowns resolved:

1. **R-1**: i18n library → `next-intl`
2. **R-2**: Microsoft OAuth provider setup in Supabase Auth (multi-tenant `common` config; we restrict at app level)
3. **R-3**: JWT custom-claim access pattern in RLS (via Supabase Auth hook → `app_metadata`)
4. **R-4**: Email normalization → `citext` extension + trim trigger
5. **R-5**: Audit trigger pattern for nullable participant_id
6. **R-6**: Welcome-dismissed update via SECURITY DEFINER RPC
7. **R-7**: Playwright + Supabase local-stack pattern (JWT injection for OAuth tests)

---

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md) — `participants`, `tournament_config`, `audit_log` schemas; RLS policies; SECURITY DEFINER functions; trigger definitions
- [contracts/](./contracts/) — RPC contracts (`provision_participant_from_jwt`, `update_display_name`, `dismiss_welcome`, `record_auth_failure`) + PostgREST surface
- [quickstart.md](./quickstart.md) — local dev setup, OAuth configuration, verification steps

**Stack constitution updates** (this plan):
- `constitution-frontend.md` — adds `next-intl` and `@supabase/ssr` to the dependency table; adds accessibility test command
- `constitution-backend.md` — adds `citext` extension and `pgTAP` testing approach; adds Microsoft OAuth provider configuration command

---

## Phase 2: Task Planning Approach

*This section describes what `/ai1st-dev-tasks` will do — DO NOT execute during `/plan`.*

### Task Generation Strategy

The `/ai1st-dev-tasks` command will:

1. **Bootstrap (T001–T005)** — Next.js + Supabase project scaffolding, install dependencies (`next-intl`, `@supabase/ssr`), configure `tsconfig.json` strict mode, set up Tailwind v4
2. **Migrations (T006–T014)** — One task per `supabase/migrations/*.sql` file (9 migrations enumerated in data-model.md), in chronological order
3. **pgTAP tests (T015–T019, parallel [P])** — One per RLS / function test in `test/pgtap/`; can run in parallel with their corresponding migration's task
4. **Auth hook (T020)** — `supabase/auth-hooks/before-issue-token.ts` for JWT `tid` + `oid` claim mapping
5. **Supabase client setup (T021–T023)** — `lib/supabase/server.ts`, `client.ts`, `middleware.ts`
6. **i18n setup (T024–T026)** — next-intl config, three message catalogs, `middleware.ts` integration
7. **Public routes (T027–T030)** — Landing, /access-denied, /auth-error, /privacy
8. **Auth callback (T031)** — `app/auth/callback/route.ts` calling `provision_participant_from_jwt()` and routing on outcome
9. **Participant routes (T032–T034)** — Dashboard with welcome modal trigger, Profile, Sign-out
10. **Components (T035–T038, parallel [P])** — SignInButton, WelcomeModal, PrivacyLink, profile-edit form
11. **Playwright E2E (T039–T053, parallel [P])** — One per acceptance scenario (TC-1 through TC-13 + i18n test)
12. **Stack constitution post-implementation review (T054)** — Verify additions, update for any newly-discovered libraries

### Ordering Strategy

- **Database first**: extensions → tables → triggers → RLS → SECURITY DEFINER functions
- **Auth callback wiring**: Microsoft OAuth provider config → Supabase Auth hook → callback handler → middleware
- **Pages in dependency order**: public routes → auth callback → participant routes
- **E2E tests last**: require full stack running
- **pgTAP tests parallel**: with their respective migration tasks [P]

**Estimated Output**: 50–55 numbered, ordered tasks in `tasks.md`

**IMPORTANT**: This phase is executed by the `/ai1st-dev-tasks` command, NOT by `/ai1st-dev-plan`.

---

## Dependencies Analysis

### Prerequisites

| Dependency | Source | Status | Notes |
|---|---|---|---|
| Next.js + Supabase project scaffold | This plan, Phase 1 | Required | Bootstrap before T006 |
| Supabase CLI installed | `constitution-backend.md` §II | Required | `npm install -g supabase` |
| Docker (local Supabase stack) | `constitution-backend.md` §II | Required | For `supabase start` |
| Microsoft OAuth app registration in Nortal Entra | OD-007 follow-up #2 (FA-1) | Required for production | Mock provider acceptable for local dev/CI |
| Nortal Entra tenant ID value | OD-001 / FA-1 | Required for production | Stored in `tournament_config.nortal_tenant_id` |
| Vercel project + env vars | OD-007 follow-up | Required for staging | `anon`, `service_role`, `AUTH_AZURE_*` |

### Provides (to other features)

| Output | Used By | Description |
|---|---|---|
| `participants` table + RLS pattern | All future features | Identity foundation; RLS template for tenant-gated data |
| `audit_log` + nullable-participant_id pattern | All audited features | Single audit table convention (ADR-010) |
| Per-request RLS eligibility (`tid` check) pattern | All authenticated routes | ADR-009 reusable predicate (`is_eligible_nortal_user()`) |
| `/access-denied` and `/auth-error` route convention | Any feature with provider failures | ADR-011 split route pattern |
| i18n infrastructure (next-intl) | All UI features | Trilingual launch baseline (ADR-008) |
| Welcome-modal pattern | Future onboarding modals | Cross-device dismissal via DB column + RPC |
| Auth callback Route Handler | Future OAuth flows | Reference implementation |

---

## Work Streams

### Active Streams for This Feature

- [x] **[API]** — Supabase RPC functions, auth callback wiring
- [x] **[UI]** — Public + participant routes, components, welcome modal, profile-edit form
- [x] **[DB]** — Migrations (extensions, tables, triggers, RLS, functions), pgTAP tests
- [x] **[TEST]** — Playwright E2E suite, pgTAP suite, test helpers (JWT injection)
- [x] **[INFRA]** — Supabase local-stack config, Microsoft OAuth provider setup, Vercel env vars
- [x] **[INT]** — Cross-stream integration (auth callback → DB provisioning → UI redirect)

### Stream Dependencies

- **[UI]** depends on: **[DB]** migrations applied (so PostgREST has the schema, generated types compile)
- **[TEST]** (Playwright) depends on: full stack running
- **[INFRA]** (OAuth registration) depends on: Nortal IT (FA-1); mockable for local dev / CI
- **[INT]** depends on: All other streams ready for end-to-end smoke

---

## Complexity Tracking

*Empty — no constitution violations identified; no complexity justifications needed.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | — | — |

---

## Use Case Specific NFRs

*Project-wide NFRs are in `../.ai_project_memory/architecture.md`. This section captures only feature-unique NFRs from the spec.*

### Performance

| Requirement | Target | Measurement |
|---|---|---|
| **NFR-A1** — Per-request RLS overhead | ≤ 10 ms | Postgres `EXPLAIN ANALYZE` on representative `participants` SELECT |
| **NFR-A2** — OAuth round-trip (sign-in click → dashboard) | ≤ 3 s | Playwright timing measurement, excluding Microsoft pages |

### Reliability

| Requirement | Target | Measurement |
|---|---|---|
| **NFR-A3** — Audit-log `auth.rejected` write | Always written, no rollback on failed sign-in | pgTAP test injecting an ineligible JWT; assert audit row present |

### Accessibility

| Requirement | Target | Measurement |
|---|---|---|
| **NFR-A4** — Welcome modal: focus trap, Esc dismiss, screen-reader announce | WCAG 2.1 AA | Playwright `@axe-core/playwright` audit |

### Localization

| Requirement | Target | Measurement |
|---|---|---|
| **NFR-A5** — Browser locale detection (en / es / pt-BR), English fallback | All user-facing surfaces | Playwright tests with three `Accept-Language` headers |

---

## Acceptance Criteria

### BRD Traceability
*Architecture spec references: FR-001, FR-002, FR-003, FR-018, NFR-006, §11.1, §11.3*
*Spec references: FR-A1 … FR-A10, NFR-A1 … NFR-A5, FC-1 … FC-3, FA-1 … FA-4*

### Authentication
- [FR-001] Only authenticated users whose JWT `tid` matches `tournament_config.nortal_tenant_id` can access protected routes
- [FR-002] Ineligible users redirected to `/access-denied`; **no participant row created** (FC-2); `audit_log` entry written with action `auth.rejected`
- [FR-003] First successful eligible sign-in auto-creates participant row from JWT (`oid`, `email`, `name`); `role` derived from admin allow-list
- [FR-A1] RLS policies validate JWT `tid` claim on every authenticated request — verified by Playwright TC-7 (inject revoked-tenant JWT mid-session)
- [FR-A6] `last_login_at` updated on every successful sign-in

### Provisioning & profile
- [FR-A2] Authenticated participant can edit `display_name` via `update_display_name()` RPC; change persisted, audited, reflected on leaderboard
- [FR-A4] Previously-eligible participant whose `tid` no longer matches has `status` flipped to `inactive`; predictions and history preserved
- [FR-A5] Role re-evaluated on every sign-in against `admin_oids` allow-list; downgrade/upgrade audited

### Public surfaces
- [FR-A7] `/access-denied` accessible without auth; renders cleanly when reached directly; "Sign in with a different account" affordance
- [FR-A9] `/auth-error` reached on non-eligibility OAuth failures; **Retry** CTA restarts the OAuth flow; failure audited as `auth.provider-error`
- [FR-A10] `/privacy` accessible without auth; notice content matches FR-A10 requirements; reachable from landing-page link AND welcome-modal "Learn more"

### Welcome modal
- [FR-A3] Welcome modal shown on first dashboard load only (gated by `welcome_dismissed_at IS NULL`); explains scoring, lock window, final-prediction deadline, privacy summary
- [TC-12] Dismissal persists cross-device via `dismiss_welcome()` RPC writing to `welcome_dismissed_at`
- [NFR-A4] Modal meets WCAG 2.1 AA (focus trap, Esc, screen-reader announce)

### Internationalization
- [FR-A8] Landing, sign-in button, welcome modal, /access-denied, /auth-error, /privacy, profile all available in en / es / pt-BR
- [NFR-A5] Browser `Accept-Language` selects supported language; English fallback for unsupported

### Constraints
- [FC-1] Missing `nortal_tenant_id` configuration → all sign-ins fail (fail-closed); deployment runbook verifies presence
- [FC-2] No participant row created for ineligible users — verified by pgTAP test
- [FC-3] No client-side automatic OAuth retry; **Retry** CTA is always user-initiated

---
*Based on Constitution — see `../.ai_project_memory/constitution.md` and `constitution-{frontend,backend}.md`*
