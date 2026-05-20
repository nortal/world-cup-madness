# Tasks: Authentication and Participant Provisioning (001)

**Input**: Design documents in `/specs/001-authentication-and-participant/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md)
**Branch**: `001-authentication-and-participant`
**Total tasks**: 80
**Generated**: 2026-05-15 (via `/ai1st-dev-tasks`)

---

## Implementation Strategy

**MVP scope**: Phase 3 (US1) — eligible Nortal user can sign in and reach the dashboard. Once US1 ships, Phase 4 (US2 — rejection) and Phase 5 (US3 — provider error) close the security and error paths. US4–US8 are layered features (admin, welcome modal, profile, privacy, i18n verification) added incrementally on top of the MVP foundation.

**Execution model**: Per project memory (see `.claude/projects/.../memory/feedback_tasks_via_subagents.md`), tasks are dispatched to subagents during `/ai1st-dev-implement`. Main thread orchestrates; subagents execute. Tasks marked `[P]` within a phase can be dispatched in parallel — one Agent call per task in a single message. See [Subagent Dispatch](#subagent-dispatch) below.

**Format reference**: `- [ ] [TaskID] [P?] [Story?] Description with file path`. All paths relative to `project-repos/world-cup-madness/` unless absolute.

---

## Phase 1: Setup

- [x] T001 Initialize Next.js 15 App Router project at `project-repos/world-cup-madness/`: create `package.json`, `tsconfig.json` (strict mode, `"target": "ES2022"`), `next.config.ts`, `app/layout.tsx`, `app/page.tsx` placeholder
- [x] T002 Install runtime deps: `npm install next@15 react@19 react-dom@19 @supabase/supabase-js @supabase/ssr next-intl tailwindcss@4 @tailwindcss/postcss postcss autoprefixer`
- [x] T003 Install dev deps: `npm install -D typescript @types/react @types/react-dom @playwright/test @axe-core/playwright jest @testing-library/react @testing-library/jest-dom eslint eslint-config-next prettier prettier-plugin-tailwindcss supabase`
- [x] T004 [P] Configure ESLint at `.eslintrc.json` (extend `next/core-web-vitals`; strict TS rules; `no-console: warn`)
- [x] T005 [P] Configure Prettier at `.prettierrc` with `prettier-plugin-tailwindcss`
- [x] T006 [P] Initialize Supabase local stack: `npx supabase init` (creates `supabase/config.toml`); add `[auth.external.azure]` block per `quickstart.md` Step 6
- [x] T007 [P] Create env template at `.env.example` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_AZURE_CLIENT_ID`, `AUTH_AZURE_SECRET`, `AUTH_AZURE_TENANT_ID`
- [x] T008 [P] Configure Tailwind CSS v4 at `app/globals.css` and `tailwind.config.ts` (default theme; Nortal-friendly font stack)

---

## Phase 2: Foundational (BLOCKING — all user story phases depend on this)

### Database migrations (sequential — each depends on previous)

- [x] T009 Migration `supabase/migrations/0001_extensions.sql`: `CREATE EXTENSION IF NOT EXISTS citext` (per `data-model.md` Extensions section)
- [x] T010 Migration `supabase/migrations/0002_create_tournament_config.sql`: singleton `tournament_config` table per `data-model.md` Tables → tournament_config
- [x] T011 Migration `supabase/migrations/0003_create_participants.sql`: `participants` table + indexes + `trim_participant_email()` BEFORE-INSERT/UPDATE trigger per `data-model.md` Tables → participants
- [x] T012 Migration `supabase/migrations/0004_create_audit_log.sql`: `audit_log` table with nullable `participant_id` + indexes per `data-model.md` Tables → audit_log
- [x] T013 Migration `supabase/migrations/0005_audit_triggers.sql`: `audit_participants_changes()` SECURITY DEFINER function + AFTER-INSERT and AFTER-UPDATE triggers per `data-model.md` Audit Trigger
- [x] T014 Migration `supabase/migrations/0006_provision_function.sql`: `provision_participant_from_jwt()` and `record_auth_failure()` SECURITY DEFINER functions with explicit REVOKE/GRANT per `data-model.md`
- [x] T015 Migration `supabase/migrations/0007_profile_functions.sql`: `update_display_name(text)` and `dismiss_welcome()` SECURITY DEFINER functions with REVOKE/GRANT per `data-model.md`
- [x] T016 Migration `supabase/migrations/0008_rls_policies.sql`: `is_eligible_nortal_user()` STABLE predicate, RLS policies for `participants` / `tournament_config` / `audit_log`, `participants_public` view per `data-model.md`
- [x] T017 Migration `supabase/migrations/0009_seed_admin.sql`: insert singleton `tournament_config` row (`nortal_tenant_id` from `AUTH_AZURE_TENANT_ID` env or hardcoded test UUID for local dev; `admin_oids` initial empty array)

### pgTAP tests (parallel; each depends on its respective migration applied via `supabase db reset`)

- [x] T018 [P] pgTAP test `test/pgtap/001_rls_participants.sql`: verify participants SELECT policies (own row, leaderboard, admin-all) and absence of any INSERT/UPDATE/DELETE policy for `authenticated` role
- [x] T019 [P] pgTAP test `test/pgtap/002_rls_audit_log.sql`: verify admin-only SELECT policy and absence of mutation policies (tamper-resistant)
- [x] T020 [P] pgTAP test `test/pgtap/003_provision_function.sql`: verify `provision_participant_from_jwt()` returns `outcome=success/rejected/error` for eligible / ineligible / missing-config scenarios; verify FC-1 (fail-closed) and FC-2 (no participant row for ineligible)
- [x] T021 [P] pgTAP test `test/pgtap/004_email_normalization.sql`: insert participants with `Mike@Nortal.com` / `mike@nortal.com` / `  MIKE@NORTAL.COM  `; verify UNIQUE-violation collision and canonical stored value (R-4 / TC-13 backing)
- [x] T022 [P] pgTAP test `test/pgtap/005_audit_trigger.sql`: verify INSERT writes `participant.created`; UPDATE of role writes `participant.role-changed`; UPDATE of status to inactive writes `participant.deactivated` with reason `tenant.departure`; other UPDATEs write `participant.updated`

### Auth hook + Supabase clients (T023 depends on Supabase Auth provider config from T006)

- [x] T023 Auth hook at `supabase/auth-hooks/before-issue-token.ts` (TypeScript / Deno): copies Microsoft JWT claims (`tid`, `oid`) from `provider_token` into Supabase session JWT `app_metadata` per research R-3
- [x] T024 [P] Supabase server client at `lib/supabase/server.ts` using `@supabase/ssr` `createServerClient()` + Next.js `cookies()`
- [x] T025 [P] Supabase browser client at `lib/supabase/client.ts` using `@supabase/ssr` `createBrowserClient()`
- [x] T026 [P] Supabase middleware helper at `lib/supabase/middleware.ts`: session-refresh function consumed by top-level `middleware.ts`
- [x] T027 Generate Supabase TypeScript types: `npx supabase gen types typescript --local > lib/supabase/database.types.ts` (depends on T009–T017 applied)

### i18n setup

- [x] T028 [P] next-intl config at `lib/i18n/config.ts`: locales `['en', 'es', 'pt-BR']`, default `en`, message-loader function per ADR-008
- [x] T029 [P] Translation file `lib/i18n/messages/en.json` (initial empty stub `{}`; populated per-story)
- [x] T030 [P] Translation file `lib/i18n/messages/es.json` (initial empty stub)
- [x] T031 [P] Translation file `lib/i18n/messages/pt-BR.json` (initial empty stub)
- [x] T032 Top-level `middleware.ts` at repo root of `project-repos/world-cup-madness/`: chain `next-intl` Accept-Language detection (T028) with Supabase session refresh (T026); ensures both run on every request

### Test scaffolding

- [x] T033 [P] Playwright config at `playwright.config.ts` with default `chromium` project + `accessibility` project that runs `@axe-core/playwright`
- [x] T034 [P] Playwright fixtures at `e2e/fixtures/auth.ts`: helpers `signInAs({ tenant: 'eligible' | 'ineligible', oid?, role? })` that JWT-inject via `supabase.auth.signInWithIdToken()` per research R-7
- [x] T035 [P] Test fixture at `e2e/fixtures/db.ts`: helper `resetSupabaseState()` that truncates `participants` + `audit_log` between tests; helper `seedAdmin(oid)` that updates `tournament_config.admin_oids`

---

## Phase 3 (US1): Eligible Nortal user can sign in and reach dashboard ⭐ MVP

**Story goal**: An eligible Nortal user (whose JWT `tid` matches `tournament_config.nortal_tenant_id`) clicks **Sign in with Microsoft**, completes OAuth, is auto-provisioned, and lands on the participant dashboard with `last_login_at` updated. Per-request RLS validation enforced on every subsequent navigation.

**Independent test**: TC-1 (new eligible user) + TC-2 (returning user) + TC-7 (per-request RLS) Playwright tests pass against a freshly-reset Supabase local stack.

**Covers**: FR-001, FR-003, FR-A1, FR-A6 (English baseline; full trilingual coverage verified in US8).

- [x] T036 [US1] Public landing page at `app/(public)/page.tsx` (Server Component): one-line description + `<SignInButton />`; uses next-intl `t('landing.headline')` etc.
- [x] T037 [US1] [P] Sign-in button at `components/auth/SignInButton.tsx` (Client Component): calls `supabase.auth.signInWithOAuth({ provider: 'azure', options: { scopes: 'openid email profile', redirectTo: '${window.location.origin}/auth/callback' } })`
- [x] T038 [US1] Auth callback Route Handler at `app/auth/callback/route.ts`: `exchangeCodeForSession(code)` → call `supabase.rpc('provision_participant_from_jwt')` → redirect on `outcome` (`success` → `/dashboard`, `rejected` → `/access-denied`, `error` → `/auth-error`); see `contracts/rpc-provision-participant.md` for response shape
- [x] T039 [US1] [P] Sign-out Route Handler at `app/auth/sign-out/route.ts`: `supabase.auth.signOut()` → redirect to `/`
- [x] T040 [US1] Participant dashboard at `app/(participant)/dashboard/page.tsx` (Server Component): fetch participant row including `welcome_dismissed_at`, render greeting + placeholder for upcoming-matches list (full prediction UI is a future feature)
- [x] T041 [US1] [P] Add en/es/pt-BR translation keys for landing + sign-in button + dashboard greeting + dashboard empty-state to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T042 [US1] [P] Playwright test `e2e/tests/auth-eligible-new-user.spec.ts` (TC-1): JWT-inject eligible new user → assert participant row created with correct `oid`/`email`/`display_name`, `last_login_at` set, redirect to `/dashboard`
- [x] T043 [US1] [P] Playwright test `e2e/tests/auth-eligible-returning.spec.ts` (TC-2): pre-seed existing participant → JWT-inject same `oid` → assert no new row, `last_login_at` updated
- [x] T044 [US1] [P] Playwright test `e2e/tests/auth-per-request-rls.spec.ts` (TC-7): JWT-inject eligible user, then mutate session JWT to a non-Nortal `tid` → assert next authenticated query is denied at the RLS layer (no rows returned for own participant SELECT)

---

## Phase 4 (US2): Ineligible user rejected with audit trail

**Story goal**: A user outside the Nortal Entra tenant — or a previously-eligible user removed from the tenant — is redirected to `/access-denied`. No new participant row created; existing rows have `status` flipped to `inactive`. Audit trail captures the rejection (`auth.rejected`) and the deactivation (`participant.deactivated` with reason `tenant.departure`).

**Independent test**: TC-5 (ineligible) + TC-6 (tenant departure) + TC-8 (admin audit search) Playwright tests pass.

**Covers**: FR-002, FR-A4, FR-A7.

- [x] T045 [US2] `/access-denied` page at `app/(public)/access-denied/page.tsx` (Server Component): rejection message ("This pool is only available to Nortal collaborators…"), "Sign in with a different account" button (links to `/auth/sign-out` then `/`), contact-info placeholder
- [x] T046 [US2] [P] Add en/es/pt-BR translation keys for `/access-denied` (heading, body, retry CTA, contact line) to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T047 [US2] [P] Playwright test `e2e/tests/auth-ineligible-rejection.spec.ts` (TC-5): JWT-inject user with non-Nortal `tid` → assert no participant row exists for that `oid`, `audit_log` has `auth.rejected` row with `actor_oid` + `actor_email` + `attempted_tid`, redirect lands on `/access-denied`
- [x] T048 [US2] [P] Playwright test `e2e/tests/auth-tenant-departure.spec.ts` (TC-6): pre-seed active participant → JWT-inject same `oid` with non-Nortal `tid` → assert participant `status='inactive'`, audit_log has BOTH `participant.deactivated` (reason `tenant.departure`) and `auth.rejected` rows, predictions placeholder data preserved
- [x] T049 [US2] [P] Playwright test `e2e/tests/audit-search-auth-failures.spec.ts` (TC-8): seed admin, sign in as admin, query `audit_log` via PostgREST filtered by `action='auth.rejected'` → assert returned rows include the columns admins need (oid, email, attempted_tid, occurred_at)

---

## Phase 5 (US3): Recoverable provider failures land on /auth-error

**Story goal**: When OAuth fails for non-eligibility reasons (Microsoft Entra unavailable, callback `exchangeCodeForSession` failure, OAuth `state` cookie mismatch, malformed authorization code), user is redirected to `/auth-error` with a Retry CTA. Failure audited as `auth.provider-error`. **No silent client-side auto-retry** (FC-3).

**Independent test**: TC-10 Playwright test passes.

**Covers**: FR-A9, FC-3, NFR-A3.

- [x] T050 [US3] `/auth-error` page at `app/(public)/auth-error/page.tsx` (Server Component): "Sign-in didn't complete" message, prominent **Retry** button (links to landing page sign-in flow), contact info, optional service-status link
- [x] T051 [US3] Update auth callback handler `app/auth/callback/route.ts` (modified from T038): wrap `exchangeCodeForSession` in try/catch; on failure call `supabase.rpc('record_auth_failure', { p_action: 'auth.provider-error', p_oid: null, p_email: null, p_attempted_tid: null, p_reason: 'callback.exchange-failed' })` and redirect to `/auth-error`
- [x] T052 [US3] [P] Add en/es/pt-BR translation keys for `/auth-error` (heading, body, retry button, contact line, status link) to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T053 [US3] [P] Playwright test `e2e/tests/auth-provider-error.spec.ts` (TC-10): mock callback exchange failure (e.g. invalid `code` query param) → assert redirect to `/auth-error`, `audit_log` has `auth.provider-error` row with `reason='callback.exchange-failed'`, clicking **Retry** navigates back to landing → triggers fresh OAuth flow

---

## Phase 6 (US4): Admin role recognition + dynamic role updates

**Story goal**: A user whose `oid` is in `tournament_config.admin_oids` gets `role='admin'` on every sign-in. Removal from the list demotes them to `role='participant'` on next sign-in (audit row written: `participant.role-changed`).

**Independent test**: TC-3 + TC-9 Playwright tests pass.

**Covers**: FR-A5.

- [x] T054 [US4] Update dashboard `app/(participant)/dashboard/page.tsx` (modified from T040): conditionally render an `<AdminNavLink />` stub when `participant.role === 'admin'` (link target placeholder for future admin console)
- [x] T055 [US4] [P] Playwright test `e2e/tests/auth-admin-role.spec.ts` (TC-3): seed admin oid, JWT-inject that user → assert participant `role='admin'`, dashboard renders the admin-nav element
- [x] T056 [US4] [P] Playwright test `e2e/tests/auth-role-downgrade.spec.ts` (TC-9): provision participant as admin, then update `tournament_config.admin_oids` to remove that oid, then re-sign-in → assert `role='participant'`, `audit_log` has `participant.role-changed` row, admin-nav element no longer rendered

---

## Phase 7 (US5): First-login welcome modal with cross-device persistence

**Story goal**: On first dashboard load (when `welcome_dismissed_at IS NULL`), participant sees a dismissible modal explaining scoring (10 / 5 / 0 points), final-prediction scoring (20 each, four items), the 60-minute lock window, and the first-kickoff deadline for final predictions, plus a one-line privacy summary. Dismissal persists cross-device via `dismiss_welcome()` RPC.

**Independent test**: TC-12 + accessibility audit (NFR-A4) pass.

**Covers**: FR-A3, NFR-A4.

- [x] T057 [US5] WelcomeModal Client Component at `components/auth/WelcomeModal.tsx`: focus trap, Esc to close, ARIA `role="dialog"` + `aria-labelledby` + `aria-modal`, "Got it" button calls `supabase.rpc('dismiss_welcome')` then closes locally; uses next-intl `t('welcome.title')` etc.
- [x] T058 [US5] Update dashboard `app/(participant)/dashboard/page.tsx` (modified from T040): pass `is_first_login` (derived from `welcome_dismissed_at IS NULL`) to a Client Component wrapper `<DashboardClient>` that conditionally mounts `<WelcomeModal />` on first render
- [x] T059 [US5] [P] Add en/es/pt-BR translation keys for welcome modal (title, scoring summary 4 lines, lock-window line, deadline line, "Got it" CTA) to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T060 [US5] [P] Playwright test `e2e/tests/welcome-modal-cross-device.spec.ts` (TC-12): sign in as new user, dismiss modal, verify `welcome_dismissed_at` set in DB; sign out, sign back in in a fresh browser context → assert modal does NOT appear
- [x] T061 [US5] [P] Playwright test `e2e/tests/welcome-modal-a11y.spec.ts` (NFR-A4): @axe-core/playwright audit on dashboard with welcome modal open + assert keyboard navigation (Tab traps focus inside modal, Esc dismisses)

---

## Phase 8 (US6): Profile / display name editing

**Story goal**: An authenticated participant can edit their `display_name` from a profile page. Changes persist (audited as `participant.updated`) and reflect on the leaderboard. Email normalization (case-insensitive uniqueness) verified end-to-end.

**Independent test**: TC-4 + TC-13 Playwright tests pass.

**Covers**: FR-A2.

- [x] T062 [US6] Profile page at `app/(participant)/profile/page.tsx` (Server Component): fetch current `display_name` and `email`, render `<DisplayNameForm initialValue={displayName} />`
- [x] T063 [US6] [P] Display-name edit form at `components/profile/DisplayNameForm.tsx` (Client Component): controlled input (1–100 chars validation client-side), Submit calls `supabase.rpc('update_display_name', { new_name: value })`, optimistic UI update, error toast on `check_violation` / `no_data_found`
- [x] T064 [US6] [P] Add en/es/pt-BR translation keys for profile page heading + form labels + validation errors + success toast to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T065 [US6] [P] Playwright test `e2e/tests/profile-edit-display-name.spec.ts` (TC-4): sign in, navigate to `/profile`, change display_name, submit → assert DB row updated, audit_log has `participant.updated` with old/new value, dashboard greeting reflects new name
- [x] T066 [US6] [P] Playwright test `e2e/tests/email-case-insensitive.spec.ts` (TC-13): JWT-inject `Mike@Nortal.com` → assert single row created with canonical `mike@nortal.com`; JWT-inject `MIKE@NORTAL.COM` for the same `oid` → assert no new row created

---

## Phase 9 (US7): Privacy notice + transparency

**Story goal**: Public `/privacy` page describes data collected (email + display_name), purpose (eligibility + leaderboard + audit), audience (participants + admins), legal basis (legitimate interest under FA-4), and retention period. Reachable from a prominent landing-page link AND from the welcome modal "Learn more" link. **No consent capture** for MVP.

**Independent test**: TC-11 Playwright test passes.

**Covers**: FR-A10, FA-4.

- [x] T067 [US7] `/privacy` page at `app/(public)/privacy/page.tsx` (Server Component): notice content per FR-A10 (data collected, purpose, audience, legal basis, retention placeholder pending Privacy/Legal-set value); semantic HTML headings; back-to-landing link
- [x] T068 [US7] [P] PrivacyLink shared Client Component at `components/auth/PrivacyLink.tsx`: renders `<Link href="/privacy">{t('privacy.linkLabel')}</Link>`
- [x] T069 [US7] Update landing page `app/(public)/page.tsx` (modified from T036): include `<PrivacyLink />` prominently in the page chrome (footer or below the sign-in button)
- [x] T070 [US7] Update welcome modal `components/auth/WelcomeModal.tsx` (modified from T057): add 1-line privacy summary + "Learn more" `<PrivacyLink />` per FR-A3 (e) and FR-A10
- [x] T071 [US7] [P] Add en/es/pt-BR translation keys for `/privacy` notice content + privacy-link label + welcome-modal privacy summary to `lib/i18n/messages/{en,es,pt-BR}.json`
- [x] T072 [US7] [P] Playwright test `e2e/tests/privacy-notice-reachable.spec.ts` (TC-11): unauthenticated visit → click privacy link from landing → assert lands on `/privacy` with all required content sections; authenticated first-login → click "Learn more" in welcome modal → assert lands on `/privacy`

---

## Phase 10 (US8): Trilingual UI with browser locale detection

**Story goal**: All user-visible surfaces (landing, sign-in button, welcome modal, `/access-denied`, `/auth-error`, `/privacy`, profile, dashboard greeting) render in en / es / pt-BR based on the browser's `Accept-Language` header, with English fallback for unsupported languages.

**Independent test**: i18n locale-detection Playwright test passes for all three languages on every public + protected route.

**Covers**: FR-A8, NFR-A5.

- [ ] T073 [US8] Verify all en/es/pt-BR translation keys are populated for surfaces from US1-US7 (review `lib/i18n/messages/{en,es,pt-BR}.json` against the surface list in FR-A8); fix any missing keys
- [ ] T074 [US8] [P] Playwright test `e2e/tests/i18n-locale-detection.spec.ts` (NFR-A5): for each `Accept-Language` value `en`, `es`, `pt-BR`, navigate to `/`, `/access-denied`, `/auth-error`, `/privacy`, `/dashboard` (signed in), `/profile` (signed in) → assert content matches expected locale; navigate with `Accept-Language: ja` → assert English fallback

---

## Final Phase: Polish & Cross-Cutting

- [ ] T075 [P] Run accessibility audit Playwright project against all pages: `npx playwright test --project=accessibility` and resolve any axe-core violations
- [ ] T076 [P] Run full test suite: `npx supabase db test` (pgTAP) + `npx playwright test` (E2E) + `npm test` (unit / RTL) + `npx tsc --noEmit` (type-check) + `npm run lint`. Test output MUST be pristine per universal constitution §4
- [ ] T077 Verify `spec.md` Definition of Done items: all 13 TCs pass, audit search returns expected actions for all five action types, FC-1 (fail-closed) verified via T020, FC-2 (no row for ineligible) verified via T020 + T047, FC-3 (no auto-retry) verified via T053 + manual code review
- [ ] T078 [P] Update `project-repos/world-cup-madness/README.md` with auth-feature setup instructions: link to `quickstart.md`, env-var summary, troubleshooting matrix
- [ ] T079 [P] Stack constitution post-implementation review — verify `.ai_project_memory/constitution-frontend.md` and `.ai_project_memory/constitution-backend.md` reflect any newly-discovered libraries; update if needed
- [ ] T080 [P] Update `.ai/knowledge/decisions.md` with any new ADRs surfaced during implementation (none expected; revisit only if a major call had to be made)

---

## Dependencies

### Phase-level
- **Phase 1** (Setup) → **Phase 2** (Foundational) → **Phase 3+** (User Stories) → **Final Phase** (Polish)
- All user-story phases (US1–US8) require Phase 2 complete
- Within Phase 2, migrations T009 → T010 → … → T017 are strictly sequential (each builds on the previous schema)
- pgTAP tests T018–T022 are parallel with each other but each requires its respective migration applied first (and `supabase db reset` to load all migrations)
- T027 (generate types) requires T009–T017 all applied
- T032 (top-level middleware) requires T026 (Supabase middleware helper) AND T028 (next-intl config)

### Story-to-story dependencies
- **US1** is the MVP — minimum viable auth flow
- **US2** + **US3** add error/security paths — independent of each other and of US4–US8
- **US4** (admin) depends on US1 (dashboard exists for admin nav)
- **US5** (welcome modal) depends on US1 (dashboard exists for modal mounting)
- **US6** (profile) depends on US1 (dashboard exists for profile-link navigation)
- **US7** (privacy) depends on US1 (PrivacyLink used in landing) AND US5 (welcome modal "Learn more")
- **US8** (i18n verification) depends on US1–US7 complete (verifies their translations)

### Cross-task file modifications (sequential within affected files)
- T038 (auth callback) → T051 (US3 wraps in try/catch) — same file, sequential
- T040 (dashboard) → T054 (US4 admin nav) → T058 (US5 welcome wrapper) — same file, sequential within affected stories
- T036 (landing) → T069 (US7 adds PrivacyLink) — same file, sequential
- T057 (welcome modal) → T070 (US7 adds privacy summary) — same file, sequential

---

## Parallel Execution Examples

### Phase 2: pgTAP tests in parallel (after T009–T017 applied)

Single message with five Agent calls dispatched concurrently (per subagent-dispatch rule):
- T018 — RLS on participants
- T019 — RLS on audit_log
- T020 — provision function outcomes
- T021 — email normalization
- T022 — audit trigger behaviour

### Phase 3 (US1): three test files in parallel

After T036–T041 are complete, dispatch:
- T042 (TC-1) via `playwright-test-generator` agent
- T043 (TC-2) via `playwright-test-generator` agent
- T044 (TC-7) via `playwright-test-generator` agent

### Phase 5 (US3): T050 + T052 + T053 in parallel

T051 modifies the same file as T038 (sequential), but T050 (new page), T052 (i18n keys), T053 (test) are all in different files and can dispatch concurrently.

### Final Phase: T075 + T076 + T078 + T079 + T080 in parallel

All polish tasks marked `[P]` can dispatch in one message.

---

## Subagent Dispatch

Per the saved feedback memory (`feedback_tasks_via_subagents.md`): tasks are dispatched to subagents during `/ai1st-dev-implement`. Recommended `subagent_type` per task class:

| Task class | Subagent type | Notes |
|---|---|---|
| Setup, migrations, TypeScript code, SQL functions (most tasks) | `general-purpose` | Full tool access; needs file-write permissions |
| Playwright test generation (TC-* and i18n tests) | `playwright-test-generator` | Specialized for Playwright spec authoring |
| Final TC coverage + constitution-compliance verification (T077) | `verification-agent` | Read-only review |
| pgTAP test generation (T018–T022) | `general-purpose` | No specialised SQL test agent available |
| Git operations (commits, branch hygiene, status checks) | **Main thread, NOT subagents** | Sequencing matters; main thread holds repo state |
| Stack constitution updates (T079) | `documentation-agent` | Lightweight doc edits |

**Each Agent prompt MUST be self-contained**:
- Verbatim task description from this file (the bullet text)
- Reference to `spec.md` (with section anchor when relevant) for acceptance criteria
- Reference to `data-model.md` / `plan.md` / `research.md` for technical detail
- Exact file path(s) the task creates or modifies
- Verification criteria (test the task should make pass; or "no test changes" if a non-test task)

When dispatching parallel `[P]` tasks, send a single message with multiple `Agent` tool calls.

---

## Task Completeness Checklist

- [x] Every functional requirement (FR-001, FR-002, FR-003, FR-A1 through FR-A10) maps to at least one task
- [x] Every acceptance test case (TC-1 through TC-13) has a corresponding Playwright task
- [x] Every NFR has a verification path:
  - NFR-A1 (RLS overhead ≤ 10 ms) — measurable via T020 / T044 / T077
  - NFR-A2 (OAuth round-trip ≤ 3 s) — implicit in T042
  - NFR-A3 (audit-log written without rollback) — verified by T020 + T047
  - NFR-A4 (welcome-modal a11y) — explicit in T061
  - NFR-A5 (browser locale detection) — explicit in T074
- [x] Every feature constraint is verified:
  - FC-1 (fail-closed on missing config) — T020 + T077
  - FC-2 (no participant row for ineligible) — T020 + T047
  - FC-3 (no client-side auto-retry) — T053 + manual code review in T077
- [x] Every entity in `data-model.md` has a migration task (T009–T017)
- [x] Every contract in `contracts/` has implementation + test tasks:
  - `provision_participant_from_jwt` → T014 (function) + T038 (caller) + T042/T043/T047/T048 (tests)
  - `update_display_name` → T015 (function) + T063 (caller) + T065 (test)
  - `dismiss_welcome` → T015 (function) + T057 (caller) + T060 (test)
  - `record_auth_failure` → T014 (function) + T051 (caller) + T053 (test)
- [x] All `[P]` tasks are truly independent (different files, no in-phase task ordering required)
- [x] Every task specifies an exact file path
- [x] Stories are independently testable (each phase has at least one Playwright test that doesn't depend on later-phase tasks)
- [x] All tasks follow the strict checklist format `- [ ] [TaskID] [P?] [Story?] Description with file path`

---

## Notes

- `[P]` = parallelizable (different files, no in-phase dependencies)
- `[USx]` = user-story phase tag (required in Phase 3+); absent in Setup, Foundational, and Polish phases
- Verify pgTAP and Playwright tests fail before implementing the corresponding code (TDD-friendly)
- Commit after each task — small, focused commits per universal constitution §3.2 (Conventional Commits format)
- Avoid: vague tasks, same-file conflicts within `[P]` group, missing file paths, missing TaskID
