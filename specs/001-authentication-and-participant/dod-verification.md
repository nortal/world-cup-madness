# US1-US8 Definition-of-Done Verification

**Date:** 2026-05-19
**Branch:** `001-authentication-and-participant`
**Scope:** Auth feature (US1-US8) — verifies the `spec.md` §6 Definition of Done
plus the §11 fail-closed constraints FC-1/FC-2/FC-3.

## Per-DoD-item status

| # | DoD item | Status | Evidence |
|---|---|---|---|
| 1 | FR-001, FR-002, FR-003, FR-A1–FR-A7 implemented | ✅ Done | See FR coverage table below |
| 2 | All 13 TCs pass in automated tests | ✅ 13/13 | See TC coverage table below |
| 3 | Edge cases in spec §3 handled | ✅ Done | Audit + tenant departure + email canon — pgTAP + Playwright |
| 4 | Audit-log entries verifiable for 5 actions | ✅ Done | See action coverage table below |
| 5 | Per-request tenant enforcement (integration test) | ✅ Done | TC-7 via `auth-per-request-rls.spec.ts` (T044) |
| 6 | `/access-denied` unauth-accessible + renders | ✅ Done | Page is `app/(public)/access-denied/page.tsx` (public route group, no auth gate); TC-5 navigates without sign-in |
| 7 | Welcome modal NFR-A4 a11y | ✅ Done | `welcome-modal-a11y.spec.ts` — axe-core scan + Tab/Esc nav, all green |
| 8 | Security review by Nortal Security (OD-007 sub #1) | ⏳ External | Not blocked at code level; tracking for go-live |
| 9 | Nortal Entra tenant ID supplied by IT (OD-007 sub #2) | ⏳ External | Deployment-time config; local seeds use placeholder UUID |
| 10 | Translations reviewed by native speakers | ⏳ External | All copy localized (en/es/pt-BR, 52 keys × 3 locales); native-speaker QA pending |
| 11 | Browser locale auto-detection verified | ✅ Done | NFR-A5 via `i18n-locale-detection.spec.ts` (T074) — 4 locale cases (en, es, pt-BR, ja-fallback) × 6 surfaces |
| 12 | `/auth-error` unauth + Retry CTA + audit entry | ✅ Done | TC-10 via `auth-provider-error.spec.ts` (T053) — both exchange-failure and missing-code branches |

## Test Case coverage (TC-1 through TC-13)

| TC | Description | Test file | Status |
|---|---|---|---|
| TC-1 | New eligible user | `auth-eligible-new-user.spec.ts` | ✅ |
| TC-2 | Returning eligible user | `auth-eligible-returning.spec.ts` | ✅ |
| TC-3 | Admin role detection | `auth-admin-role.spec.ts` | ✅ |
| TC-4 | Display-name editability | `profile-edit-display-name.spec.ts` | ✅ |
| TC-5 | Ineligible user rejected | `auth-ineligible-rejection.spec.ts` | ✅ |
| TC-6 | Soft-deactivation on tenant departure | `auth-tenant-departure.spec.ts` | ✅ |
| TC-7 | Per-request eligibility (RLS) | `auth-per-request-rls.spec.ts` | ✅ |
| TC-8 | Admin audit search for auth failures | `audit-search-auth-failures.spec.ts` | ✅ |
| TC-9 | Role downgrade | `auth-role-downgrade.spec.ts` | ✅ |
| TC-10 | Recoverable provider failure | `auth-provider-error.spec.ts` (2 variants) | ✅ |
| TC-11 | Privacy notice reachable | `privacy-notice-reachable.spec.ts` (2 paths) | ✅ |
| TC-12 | Welcome dismissed persists cross-device | `welcome-modal-cross-device.spec.ts` | ✅ |
| TC-13 | Email case-insensitive uniqueness | `email-case-insensitive.spec.ts` (2 variants) | ✅ |

## Audit-action coverage (5 action types)

| Action | Trigger source | Verified by |
|---|---|---|
| `participant.created` | AFTER INSERT trigger | pgTAP `005_audit_trigger.sql` (T022) + asserted in `auth-eligible-new-user.spec.ts` |
| `participant.updated` | AFTER UPDATE trigger (catch-all branch) | `profile-edit-display-name.spec.ts` asserts old/new value diff |
| `participant.deactivated` | AFTER UPDATE (status → inactive) | `auth-tenant-departure.spec.ts` asserts reason='tenant.departure' |
| `participant.role-changed` | AFTER UPDATE (role change) | `auth-role-downgrade.spec.ts` asserts old/new role JSONB |
| `auth.rejected` | `record_auth_failure` RPC (no FK to participants) | `auth-ineligible-rejection.spec.ts` writes, `audit-search-auth-failures.spec.ts` reads via admin |

Plus a sixth action used by US3:
- `auth.provider-error` — `auth-provider-error.spec.ts` (T053) covers both `callback.exchange-failed` and `callback.missing-code` reasons.

## FR coverage (FR-001, FR-002, FR-003, FR-A1–FR-A10)

| FR | Surface | Status |
|---|---|---|
| FR-001 | Microsoft OAuth sign-in via Supabase Auth | ✅ Landing + SignInButton + callback |
| FR-002 | Reject non-tenant + audit + `/access-denied` | ✅ TC-5 |
| FR-003 | Auto-provision participant on first sign-in | ✅ TC-1 + TC-2 |
| FR-A1 | Per-request tenant enforcement via RLS | ✅ TC-7 |
| FR-A2 | Editable display name + audit | ✅ TC-4 |
| FR-A3 | Welcome modal first-login | ✅ T057+T058 + TC-12 |
| FR-A4 | Soft-deactivation on tenant departure | ✅ TC-6 |
| FR-A5 | Role re-evaluation per sign-in | ✅ TC-3 + TC-9 |
| FR-A6 | Email case-insensitive uniqueness | ✅ TC-13 (with mechanism note — see below) |
| FR-A7 | Audit search by admin | ✅ TC-8 |
| FR-A8 | Trilingual UI (en/es/pt-BR) | ✅ All 52 keys × 3 locales |
| FR-A9 | Recoverable provider failure → `/auth-error` | ✅ TC-10 |
| FR-A10 | Privacy notice (2 surfaces) | ✅ TC-11 |

## Fail-closed constraints

### FC-1: Fail-closed on missing configuration
**Status:** ✅ Verified.
- `tournament_config` singleton has `nortal_tenant_id` (declared `NOT NULL` in migration 0002) — schema-level guarantee that the config row cannot exist without a tenant ID.
- `is_eligible_nortal_user()` RLS predicate (migration 0010) reads `tournament_config.nortal_tenant_id` and compares against the JWT's `app_metadata.tid`. If the config row were ever absent, the subquery returns NULL → predicate is NULL → RLS denies. (NULL-aware comparison cannot accidentally return TRUE.)
- pgTAP `003_provision_function.sql` (T020) covers the "missing config" branch in the provisioning RPC: returns `outcome='error'` and writes no participant row.

### FC-2: No participant row for ineligible users (ever)
**Status:** ✅ Verified.
- `provision_participant_from_jwt()` (migration 0010 lines ~75–135) checks tenant BEFORE the INSERT. Ineligible branch returns `outcome='rejected'` and calls `record_auth_failure(...)` — no participant row inserted.
- pgTAP `003_provision_function.sql` (T020) covers the ineligible-tenant branch: asserts participant count remains zero.
- Playwright `auth-ineligible-rejection.spec.ts` (T047) covers it end-to-end: assert `getParticipantByOid(oid)` returns null after the sign-in attempt.

### FC-3: No automatic OAuth retry loop
**Status:** ✅ Verified.
- Code review of `app/(public)/auth-error/page.tsx` confirms the Retry CTA is a plain `next/link` `<Link href="/">` — no `setTimeout`, no `setInterval`, no `router.push` on mount, no client-side script.
- The page is a Server Component (no `'use client'`); there is no opportunity for a client effect to fire a retry.
- TC-10 (`auth-provider-error.spec.ts`) asserts the Retry click goes to `/` — but the click is user-initiated, satisfying FC-3.
- `grep -E "setTimeout|setInterval|router\\.push|location\\.reload" app/(public)/auth-error/page.tsx app/auth/callback/route.ts` returns no matches.

## Tooling output (T076)

| Suite | Result | Notes |
|---|---|---|
| pgTAP (`npx supabase db test test/pgtap/*.sql`) | 63/63 PASS | Files=5, Tests=63 |
| Jest (`npm test`) | 25/25 PASS | 2 test suites: `locales.test.ts` + `accept-language.test.ts` |
| Playwright chromium (`npx playwright test --project=chromium`) | 22/22 PASS | ~3-5 min depending on warm vs cold start |
| Playwright accessibility (`npx playwright test --project=accessibility`) | 8/8 PASS | `welcome-modal-a11y.spec.ts` (2) + `all-pages-a11y.spec.ts` (6) |
| `npx tsc --noEmit` | 0 errors | |
| `npm run lint` | 0 warnings, 0 errors | After eslint config update to allow `console.error`/`console.warn` per Constitution §1.3 |

Combined Playwright run (`npx playwright test`) reports **36 passed**: 22 chromium + 8 accessibility + 6 from the all-pages a11y sweep that also runs under chromium (testMatch overlap is intentional — `*-a11y.spec.ts` matches both projects).

## External / non-code items still pending (do not block code-complete)

- **OD-007 sub #1** — Security review by Nortal Security
- **OD-007 sub #2** — Nortal Entra tenant ID supplied by IT (deployment-time)
- **Native-speaker translation review** for es / pt-BR
- **FA-4** — Privacy / Legal sign-off on legitimate-interest basis (would surface as an OD-008 change if consent capture is required instead)
- **Retention period** value — pending Privacy/Legal-set value per spec.md line 170; placeholder currently in `/privacy` body

## Findings worth raising with the spec authors

1. **TC-13 mechanism note**: spec text implies a DB trigger lowercases email, but the actual canonicalization happens at the Supabase Auth `auth.users` layer (lowercases on `createUser`). Trigger only trims. Observable behavior matches spec; mechanism is elsewhere. (Documented in `email-case-insensitive.spec.ts` header.)
2. **TC-13 whitespace branch unreachable via OAuth**: Supabase Auth's email-format validator rejects `'  mike@nortal.com  '` at user-creation time. pgTAP 004 covers the trigger's whitespace branch via direct INSERTs; E2E covers only the case-change variant.
3. **T070 / FR-A3(e) wording conflict** (resolved in implementation): T068 + T070 task wording uses `<PrivacyLink/>` which renders "Privacy notice", but FR-A3(e) calls for "Learn more" inside the modal. Resolved by giving PrivacyLink a `variant` prop that selects the label. Worth harmonizing T068/T070 wording with FR-A3 in a future spec edit.
4. **next-intl `localePrefix: 'never'` is misleadingly named**: it still rewrites internally to `/[locale]/...`, requiring a `[locale]` folder structure. Our flat folder layout per ADR-008 caused every non-default-locale request to 404 silently — masked through US1-US7 because manual testing was English-only. Resolved by bypassing next-intl middleware entirely; hand-rolled Accept-Language detection in `middleware.ts`. ADR-008 should be amended with a note explaining the bypass.

---

**Conclusion:** All code-complete DoD items satisfied. Outstanding items are external (security review, IT-provided tenant ID, native-speaker translation review, retention-period value). Branch is ready for the external-review gates.
