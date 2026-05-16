# Authentication and Participant Provisioning Specification

**Feature Branch**: `001-authentication-and-participant`
**Created**: 2026-05-15
**Status**: Draft
**Priority**: High
**Input**: User description: "Sign-in and participant provisioning. An eligible Nortal user (member of the Nortal Entra ID tenant per OD-001) signs in via Microsoft OAuth on a public landing page and lands on the participant dashboard with their profile auto-provisioned. An ineligible user is rejected at the OAuth boundary with a clear error message and no participant row is created. Covers FR-001, FR-002, FR-003."

---

## 1. Primary User Story

As a Nortal collaborator, I want to sign in to the World Cup Madness prediction pool using my existing Microsoft work account so that I can immediately start tracking my predictions without filling out a registration form.

**Sub-stories:**
- As an administrator, I want my admin role to be recognised automatically on sign-in so that I land on the dashboard with admin controls already visible.
- As a non-Nortal user (e.g., personal Microsoft account or another organisation), I want a clear, non-confusing rejection page when I try to access the pool so that I understand it's not for me and don't think the app is broken.
- As a former Nortal employee whose Entra tenant membership has been removed, I want my prediction history preserved in the leaderboard, but no further sign-in possible.

---

## 2. Details

**Problem:** The pool must be restricted to eligible Nortal collaborators (FR-001, FR-002) without operating its own password store, and must auto-provision a participant profile so users do not see a registration form (FR-003). Without a robust eligibility boundary the pool risks exposure to external addresses, inconsistent leaderboard data, and a poor first-time experience for legitimate users.

**Requirement Conflicts:** Requirement conflict check completed — no conflicts found (this is the first feature spec; no other UC-XX or EN-XX specifications exist yet).

---

## 3. Workflow

**Business Workflow:**

*Eligible new participant:*
1. User opens the public landing page (any URL on the app).
2. User clicks **Sign in with Microsoft**.
3. User is redirected to Microsoft to authenticate (or completes a silent sign-in if already authenticated to Entra).
4. After successful Microsoft authentication, the OAuth callback returns to the app with the user's JWT.
5. System validates the JWT's `tid` (tenant ID) claim against the configured Nortal Entra tenant ID.
6. System creates a new participant row using `display_name` and `email` from the JWT, `status='active'`, and `role='admin'` if the user's `oid` appears in the configured admin list (otherwise `role='participant'`).
7. System writes an `audit_log` entry: `action='participant.created'`.
8. System redirects the user to the participant dashboard. A first-login welcome modal explains scoring (10 / 5 / 0 points for matches; 20 points each for the four final predictions), the 60-minute match lock window, and the final-prediction deadline (first kickoff). User dismisses the modal to begin.

*Returning eligible participant:*
1–5. Same as above.
6. System finds the existing participant row, updates `last_login_at`, and re-evaluates the user's role against the admin list (writing an audit entry if the role changes).
7. System redirects to the dashboard (no welcome modal — first-login only).

*Ineligible user (different tenant or personal account):*
1. User clicks **Sign in with Microsoft** on the landing page.
2. After successful Microsoft authentication, the JWT's `tid` claim does NOT match the Nortal tenant ID.
3. System rejects the session — **no participant row is created**.
4. System writes an `audit_log` entry: `action='auth.rejected'` with `actor_oid`, `actor_email`, `attempted_tid`, and timestamp.
5. System redirects user to `/access-denied` page with the message:
   *"This pool is only available to Nortal collaborators. If you believe you should have access, please contact [admin contact email — supplied at deployment]."*
6. Page offers a **Sign in with a different account** button that returns the user to the sign-in flow.

*Previously-eligible participant whose Entra tenant membership has been revoked:*
1. User attempts to sign in.
2. Microsoft refuses the token, or the returned JWT's `tid` no longer matches the configured Nortal tenant.
3. If the user's participant row exists with `status='active'`, system flips status to `inactive` and writes an audit entry: `action='participant.deactivated'`, reason='tenant.departure'.
4. User is redirected to `/access-denied`.
5. The participant's row, predictions, scores, and audit history are preserved and continue to appear in historical leaderboards.

*Sign-in failure (non-eligibility, recoverable):*
1. User clicks **Sign in with Microsoft** on the landing page.
2. The OAuth flow fails before eligibility can be evaluated — e.g., Microsoft Entra returns 5xx, the callback receives a malformed authorization code, token exchange fails, or the OAuth `state` cookie is missing or mismatched.
3. System redirects user to `/auth-error` with a prominent **Retry** CTA, a non-technical "Sign-in didn't complete — this is usually temporary" message, contact information, and an optional service-status link.
4. System writes an `audit_log` entry: `action='auth.provider-error'`, with `actor_oid` and `actor_email` if known from partial OAuth state (otherwise null), and a `reason` summarising the failure category (`provider.5xx`, `callback.state-mismatch`, `token.exchange-failed`, etc.).
5. User clicks **Retry**; the OAuth flow starts fresh from step 1.

**Test Cases / Acceptance Scenarios:**

- **TC-1:** New eligible user — Given a Microsoft account in the Nortal Entra tenant with no prior participant row, when the user completes OAuth sign-in, then a participant row is created with `display_name` and `email` from the JWT, `role='participant'` (unless `oid` is in the admin list), `status='active'`, and the user is redirected to the dashboard with the welcome modal visible. {Source: AI/Specify}
- **TC-2:** Returning eligible user — Given an existing participant row for the signing-in user, when sign-in succeeds, then no new row is created, `last_login_at` is updated, and the user is redirected to the dashboard without the welcome modal. {Source: AI/Specify}
- **TC-3:** Admin role detection — Given a user whose `oid` is in the configured admin list, when the user signs in, then their participant `role` is set/refreshed to `admin` and admin navigation is visible on the dashboard. {Source: AI/Specify}
- **TC-4:** Display name editability — Given an active participant, when they edit their `display_name` from their profile page and save, then the change is persisted, an audit entry is written (`action='participant.updated'`, old + new values), and the new name appears on the leaderboard. {Source: AI/Specify}
- **TC-5:** Ineligible user rejected — Given a Microsoft account NOT in the Nortal Entra tenant, when the user completes OAuth, then no participant row is created, an audit entry with `action='auth.rejected'` is written containing `oid + email + attempted_tid`, and the user is redirected to `/access-denied`. {Source: AI/Specify}
- **TC-6:** Soft-deactivation on tenant departure — Given a previously-active participant whose Entra tenant membership has been revoked, when they attempt to sign in, then their `status` flips to `inactive`, an audit entry `action='participant.deactivated'` is written with reason='tenant.departure', and they are redirected to `/access-denied`. Their predictions and historical leaderboard entries remain intact. {Source: AI/Specify}
- **TC-7:** Per-request eligibility enforcement — Given a participant whose tenant membership is revoked during an active session, when their next authenticated request reaches the API, then it is denied because the JWT's `tid` no longer matches — without requiring the session to expire. {Source: AI/Specify}
- **TC-8:** Audit search for auth failures — Given multiple `auth.rejected` entries in the audit log, when an admin searches the audit log by action type, then the rejected attempts appear with `oid`, `email`, and `attempted_tid` available for investigation. {Source: AI/Specify}
- **TC-9:** Role downgrade — Given a participant whose `oid` was previously in the admin list but has since been removed, when they next sign in, then their `role` is downgraded to `participant` and an audit entry `action='participant.role-changed'` is written. {Source: AI/Specify}
- **TC-10:** Recoverable provider failure — Given Microsoft Entra returns a 5xx mid-OAuth (or the callback fails for non-eligibility reasons such as a state-cookie mismatch or token-exchange error), when the user attempts sign-in, then they are redirected to `/auth-error` (not `/access-denied`), an audit entry `action='auth.provider-error'` is written with a `reason` category and any known identifying info, and clicking **Retry** restarts the OAuth flow without manual data re-entry. {Source: AI/Clarify}
- **TC-11:** Privacy notice reachable — Given an unauthenticated visitor, when they click the "Privacy notice" link on the landing page or the "Learn more" link in the welcome modal, then they reach the public `/privacy` page which describes data collected, purpose, audience, legal basis, and retention period. The `/privacy` route MUST be accessible without authentication. {Source: AI/Clarify}
- **TC-12:** Welcome dismissed persists cross-device — Given a participant who dismissed the welcome modal on device A (setting `welcome_dismissed_at`), when the same participant signs in on device B, then the welcome modal does NOT reappear on device B's dashboard. Clearing browser cookies or using incognito does NOT cause the modal to re-trigger. {Source: AI/Clarify}
- **TC-13:** Email case-insensitive uniqueness — Given a Microsoft Entra account whose `email` claim is sent as `Mike@Nortal.com` on the very first sign-in (stored as `mike@nortal.com`), when the same `oid` later signs in with email claim `MIKE@NORTAL.COM` or `  mike@nortal.com  ` (with whitespace), then the existing participant row is matched (lookup by canonical form), no duplicate row is created, and the stored email value remains `mike@nortal.com`. {Source: AI/Clarify}

**Edge Cases:**

- *What happens when the JWT is missing the `name` claim?* `display_name` falls back to the local-part of the user's email (the segment before `@`); the fallback is recorded in the audit entry for the provisioning event.
- *What happens when the JWT's `email` claim has mixed case or surrounding whitespace?* The value is normalised (lowercased + trimmed) before storage and lookup, so the same human always maps to the same participant row regardless of Microsoft sending `Mike@Nortal.com` vs `mike@nortal.com` vs `MIKE@NORTAL.COM`. UNIQUE constraint applies to the canonical form.
- *What happens when a user already in the tenant changes their display name in Entra?* On their next sign-in the existing participant row's `display_name` is **not** auto-overwritten (because the user may have customised it via the profile page). The user can re-sync from the profile page if desired. *(See Section 5 — Deferred Decisions.)*
- *What happens when the configured Nortal tenant ID is missing or empty?* Eligibility fails for all users (fail-closed); no sign-in succeeds. This is an obvious deployment-runbook error.
- *What happens when a user navigates directly to `/access-denied` without an authentication attempt?* The page renders as a generic informational page — no error reveal.
- *What happens when an ineligible user has a participant row from a previous period of eligibility?* They are treated as the "tenant-departure" case — `status` flips to `inactive` and access is denied.
- *What happens when the welcome modal is dismissed but the user refreshes the page?* The modal does not reappear (the "first-login completed" state persists per participant).

---

## 4. Requirements

**Requirement Documents:**
- **Architecture Spec:** Nortal World Cup 2026 Prediction Pool — `project-repos/world-cup-madness/docs/architecture/high-level-architecture.md`
- **Resolved Decisions:** `project-repos/world-cup-madness/docs/architecture/open-decisions.md` (OD-001, OD-007 in particular)
- **Stack Decision:** `project-repos/world-cup-madness/docs/architecture/stack-decision.md`

**Functional Requirements:**

- **FR-001**: System MUST allow access only to authenticated users whose JWT's `tid` claim matches the configured Nortal Entra ID tenant ID. {Source: high-level-architecture.md, ID: FR-001}
- **FR-002**: System MUST reject sign-in attempts from users outside the Nortal Entra ID tenant by redirecting to `/access-denied` and writing an `audit_log` entry with `action='auth.rejected'` containing the attempted `oid`, `email`, and `tid`. No participant row may be created for an ineligible user. {Source: high-level-architecture.md, ID: FR-002}
- **FR-003**: System MUST auto-provision a participant row on the first successful eligible sign-in, populated with `display_name` (from the JWT `name` claim, falling back to the email local-part when absent), `email` (from JWT), `oid` (Microsoft object ID from JWT), `status='active'`, and `role` (`'admin'` if `oid` is in the configured admin list; otherwise `'participant'`). {Source: high-level-architecture.md, ID: FR-003}
- **FR-A1**: System MUST re-validate the JWT's `tid` claim on every authenticated request. A user whose Nortal Entra tenant membership has been revoked MUST lose access on their very next request, without waiting for session expiry. {Source: AI/Specify; derived from architecture §11.1 "validate domain eligibility on every authenticated session and critical operation"}
- **FR-A2**: System MUST allow an authenticated participant to edit their `display_name` from a profile page. The change is persisted, audited (`action='participant.updated'` with old + new value), and reflected on the leaderboard. {Source: AI/Specify}
- **FR-A3**: System MUST present a dismissible welcome modal on the dashboard for any participant for whom no previous "welcome dismissed" record exists. The modal MUST explain: (a) match scoring (10 / 5 / 0 points); (b) final-prediction scoring (20 points each, four items); (c) the 60-minute match lock window; (d) the first-kickoff deadline for final predictions; (e) a one-line privacy-notice summary with a "Learn more" link to the public `/privacy` route. {Source: AI/Specify}
- **FR-A4**: System MUST soft-deactivate any existing participant whose JWT fails the tenant check on a sign-in attempt — flipping `status` to `inactive` and writing an audit entry `action='participant.deactivated'` with reason='tenant.departure'. Predictions, scores, and audit history MUST be preserved. {Source: AI/Specify}
- **FR-A5**: System MUST re-evaluate `role` against the configured admin list on every successful sign-in, upgrading or downgrading as needed and writing an audit entry `action='participant.role-changed'` whenever the role changes. {Source: AI/Specify}
- **FR-A6**: System MUST update `last_login_at` on the participant row on every successful sign-in. {Source: AI/Specify}
- **FR-A7**: `/access-denied` MUST be publicly accessible without authentication, render successfully when reached directly, and present a "Sign in with a different account" affordance. {Source: AI/Specify}
- **FR-A8**: System MUST provide all user-visible strings within this feature's scope — landing page, **Sign in with Microsoft** button, welcome modal, `/access-denied` page, `/auth-error` page, `/privacy` page, profile page — in three languages: English (`en`), Spanish (`es`), and Brazilian Portuguese (`pt-BR`). {Source: AI/Clarify}
- **FR-A9**: When sign-in fails for non-eligibility reasons (Microsoft Entra unavailable, OAuth callback handler error, token exchange failure, OAuth `state` cookie missing or mismatched, malformed authorization code), system MUST redirect the user to `/auth-error` with: a prominent **Retry** CTA, a non-technical "this is usually temporary" message, contact information, and an optional service-status link. The failure MUST be written to `audit_log` with `action='auth.provider-error'`, `actor_oid` and `actor_email` if known, and a `reason` summarising the failure category (e.g. `provider.5xx`, `callback.state-mismatch`, `token.exchange-failed`). {Source: AI/Clarify}
- **FR-A10**: System MUST surface the privacy notice in two places: (a) a prominently linked "Privacy notice" affordance on the landing page (reachable without authentication, navigates to a public `/privacy` route), and (b) a one-line summary in the welcome modal (FR-A3) with a "Learn more" link to the same `/privacy` route. The notice content MUST describe: what personal data is collected (corporate email and display name from the Microsoft JWT); why it is collected (eligibility verification, leaderboard identity, audit trail); who can see it (other participants for display name + points; administrators for email); the legal basis for processing (legitimate interest under the Nortal employment context — per FA-4); and the retention period for predictions, scores, and audit data after the tournament concludes. **No explicit consent capture** is required for MVP. {Source: AI/Clarify}

**Feature-Specific Non-Functional Requirements:**

- **NFR-A1**: Per-request tenant re-validation MUST add no more than 10 ms of overhead to typical eligibility-protected queries.
- **NFR-A2**: The OAuth round-trip (user clicks Sign-in → user lands on dashboard) MUST complete in under 3 seconds under normal conditions, excluding time spent on Microsoft's own auth pages.
- **NFR-A3**: `audit_log` entries for `auth.rejected` MUST be written even when the sign-in is rejected — without rollback — to preserve the investigative trail.
- **NFR-A4**: The welcome modal MUST be keyboard-dismissible (Esc), trap focus while open, and announce its content to screen readers (WCAG 2.1 AA).
- **NFR-A5**: System MUST detect the user's preferred language from the browser's `Accept-Language` header on first arrival and serve the matching supported language. Matching is on the primary language subtag — `es-MX` matches `es`; `pt-PT` matches `pt-BR` as the closest supported variant. Unsupported languages fall back to English (`en`).

**Out of Scope:**

- **Region attribute on participant profile** — FR-003 mentions region "if available"; deferred because the JWT does not reliably carry country / office. Optional Microsoft Graph integration is post-MVP.
- **Self-service admin promotion / demotion** — admins are seeded via SQL migration for MVP. An admin-managed UI for promoting other users is post-MVP.
- **Entra group-based role detection** — admin role is decided via an explicit allow-list of object IDs. Group-claim integration would require Nortal IT configuration and is deferred.
- **Multi-tenant support** — only one Nortal tenant is supported. Multi-tenant pools (partner companies, etc.) are out of scope.
- **Account merging** — if a user has two Entra accounts (e.g., consultant + employee identities), each gets its own participant row. Merging is out of scope.
- **Admin-customisable welcome-modal copy** — modal content is static for MVP.
- **Multi-step onboarding tour** — single welcome modal only; no guided walkthrough.
- **User-pick language override** — language is browser-detected only for MVP; an in-UI language switcher is post-MVP.

**Clarifications:**

### Round 1 — 2026-05-15
- **Q1**: How often is the Entra `tid` claim re-validated after sign-in? → **A**: Every request — eligibility evaluated at the database layer on every query (aligns with architecture §11.1; essentially free with Supabase + RLS).
- **Q2**: What populates `display_name`, `email`, and `region` on auto-provisioning? → **A**: JWT only. `display_name` from the `name` claim; `email` from the `email` claim. `region` deferred — not in MVP.
- **Q3**: How is admin role detected? → **A**: Explicit list of Microsoft object IDs in tournament configuration. Initial admin(s) seeded via SQL migration.
- **Q4**: Where does an ineligible user end up after a failed eligibility check? → **A**: Dedicated `/access-denied` page with a "Sign in with a different account" link and a contact prompt; the failure is audited.

### Round 2 — 2026-05-15
- **Q5**: Can a participant edit their `display_name` after auto-provisioning? → **A**: Yes — editable from a profile page; edits audited.
- **Q6**: What does an eligible user see immediately after first successful sign-in? → **A**: Dashboard with a dismissible welcome modal explaining scoring, lock rules, and the final-prediction deadline.
- **Q7**: What happens when a previously-eligible user is removed from the Nortal Entra tenant? → **A**: Soft-deactivate (`status='inactive'`); preserve predictions, scores, and audit history. They cannot sign in, but their leaderboard footprint remains.
- **Q8**: What gets logged for ineligible login attempts? → **A**: Single `audit_log` table entry with `action='auth.rejected'`, `actor_oid`, `actor_email`, `attempted_tid`, and timestamp. `participant_id` is nullable for this action.

### Session 3 — /ai1st-po-clarify — 2026-05-15
- **C1**: Should sign-in / welcome / `/access-denied` copy be translated for MVP? → **A**: Yes — English (`en`), Spanish (`es`), and Brazilian Portuguese (`pt-BR`). Browser auto-detect via `Accept-Language`; English fallback. Upstream change: architecture NFR-010 strengthened from "should allow English and Spanish" to "must support English, Spanish, and Brazilian Portuguese with browser locale auto-detection".
- **C2**: How are non-eligibility OAuth failures (Microsoft Entra unavailable, callback errors, token exchange failures, state-cookie mismatch) handled? → **A**: Dedicated `/auth-error` page with **Retry** CTA, contact info, and optional service-status link. Logged as `action='auth.provider-error'` in `audit_log` with `reason` category. Distinct from `/access-denied` (permanent eligibility rejection) and from `auth.rejected` (eligibility-failure audit action) — these are recoverable conditions for otherwise-eligible users.
- **C3**: How does the privacy notice (architecture §11.3) surface, and is explicit consent captured? → **A**: Notice prominently linked from the landing page + 1-line summary in the welcome modal with "Learn more" → public `/privacy` route. **No explicit consent capture** — legal basis is legitimate interest under the Nortal employment context (voluntary internal pool). Consent-capture infrastructure can be retrofitted later if Nortal Privacy/Legal requests it. Exact retention period deferred to Deployment (Privacy/Legal-set value).
- **C4**: Where is the welcome-modal-dismissed state stored — participant row or browser? → **A**: Participant row (`participants.welcome_dismissed_at` nullable timestamp). Cross-device consistent, survives cache clears and incognito sessions. Single source of truth; schema cost is one nullable timestamp.
- **C5**: How is `participants.email` normalised for the UNIQUE constraint? → **A**: Lowercase + trim leading / trailing whitespace on insert; store the canonical form. UNIQUE applies to the stored column directly. Unicode NFC normalisation deferred (extremely unlikely in Nortal corporate emails; revisitable if encountered).

---

## 5. Deferred Decisions

- **Item:** Behaviour when an existing participant's Entra display name changes (auto-resync vs. preserve customisation). — **Rationale:** Edge case affecting a small number of users; resolution depends on whether customisation rates are high in practice. — **Resolution phase:** Implementation (revisit after first month of production data).
- **Item:** Specific email address shown on `/access-denied` for contact / appeals. — **Rationale:** Operational configuration, not architectural. — **Resolution phase:** Deployment.
- **Item:** Exact wording, illustrations, and CTAs in the welcome modal. — **Rationale:** Design / content work; not blocking the feature contract. — **Resolution phase:** Implementation.
- **Item:** Exact retention period for predictions, scores, and audit data after the tournament concludes. — **Rationale:** Nortal Privacy / Legal-set value; depends on broader Nortal retention policy and any applicable regulatory minimums. — **Resolution phase:** Deployment (must be set before launch; will be reflected in the `/privacy` notice content per FR-A10).

---

## 6. Definition of Done

- FR-001, FR-002, FR-003, and FR-A1–FR-A7 implemented and verified
- All Test Cases (TC-1 through TC-9) pass in automated tests
- Edge cases enumerated in Section 3 are handled and tested
- Audit-log entries verifiable via the admin audit search for: `participant.created`, `participant.updated`, `participant.deactivated`, `participant.role-changed`, `auth.rejected`
- Per-request tenant enforcement covered by an integration test (revoke tenant access during a live session → very next request denied)
- `/access-denied` page accessible without authentication and renders without error
- Welcome modal meets accessibility requirements (NFR-A4)
- Security review of the OAuth + tenant-allow-list approach completed by Nortal Security (OD-007 sub-condition #1)
- Nortal Entra tenant ID value supplied by Nortal IT and configured in deployment environment (OD-007 sub-condition #2 unblocker)
- All user-visible copy translated to English, Spanish, and Brazilian Portuguese; translations reviewed and approved by native-speaker reviewers
- Browser locale auto-detection verified for en / es / pt-BR users
- `/auth-error` page accessible without authentication; **Retry** CTA verified; audit entry written for `auth.provider-error` events

---

## 7. Solution Overview

This feature provides the entry point and identity foundation for the entire World Cup Madness pool. A Nortal employee or approved collaborator clicks **Sign in with Microsoft** on the public landing page; their existing Microsoft work account verifies they belong to the Nortal Entra ID tenant. If eligible, a participant profile is created automatically — they never see a registration form — and they land on the pool's main dashboard with a brief welcome explaining how the pool works.

If they are not eligible (a personal Microsoft account, or an account from a different organisation), they are redirected to a dedicated `/access-denied` page with a clear, non-shaming message and a way to retry with a different account. Their attempt is logged for security review, but no participant record is created.

The eligibility check is not enforced only at sign-in: every authenticated request re-validates tenant membership at the data layer, so a participant whose Nortal account is later disabled loses access on their very next request. Their existing predictions, scores, and audit history are preserved (the leaderboard remembers them), but they cannot sign back in unless their tenant membership is restored.

---

## 8. Key Entities

**Data Model Reference:**
- Architecture spec data model: `project-repos/world-cup-madness/docs/architecture/high-level-architecture.md` §9.1
- Feature-specific entities below.

**Participant:** A Nortal collaborator authorised to use the pool.
- **Purpose:** Authoritative identity record; ownership root for predictions, scores, and audit events.
- **Key attributes:**
  - `oid` — Microsoft object ID (stable; primary external identifier from Entra)
  - `email` — corporate email from JWT; stored as the canonical form (lowercase + leading/trailing whitespace trimmed); UNIQUE constraint applies to the stored column
  - `display_name` — leaderboard-visible name (auto-filled from JWT, user-editable)
  - `role` — `participant` or `admin` (re-evaluated at every sign-in)
  - `status` — `active` or `inactive`
  - `created_at`, `last_login_at`, `welcome_dismissed_at`
- **Relationships:** One-to-many with predictions, final predictions, and score events; many-to-one with audit entries via `actor_oid`.

**Tournament Configuration:** Operational configuration for the pool.
- **Purpose:** Holds the admin allow-list, tenant ID, and other configurable values (per FR-020).
- **Key attributes:**
  - `nortal_tenant_id` — the Nortal Entra `tid` to validate against
  - `admin_oids` — list of Microsoft object IDs granted the admin role
- **Relationships:** Referenced by the sign-in / provisioning logic and by row-level access policies.

**Audit Log Entry:** Tamper-resistant event trail.
- **Purpose:** Records authentication failures (eligibility-rejected and provider/callback errors), participant provisioning, role changes, profile edits, and deactivations.
- **Key attributes:**
  - `action` — e.g. `participant.created`, `participant.updated`, `participant.deactivated`, `participant.role-changed`, `auth.rejected`, `auth.provider-error`
  - `actor_oid` — Microsoft object ID of the actor (nullable for system events)
  - `actor_email` — actor's corporate email (nullable; populated for auth failures)
  - `participant_id` — FK to participants (nullable; null for `auth.rejected`)
  - `entity_type`, `entity_id` — target of the action
  - `old_value`, `new_value` — for updates
  - `reason` — free-text explanation (e.g. `tenant.departure`)
  - `timestamp`
- **Relationships:** Many-to-one with participants (when `participant_id` is set).

---

## 9. UX Considerations

**User Interface Context:**
- **Primary user actions:**
  1. Click **Sign in with Microsoft** on the landing page.
  2. Complete Microsoft OAuth (out-of-app).
  3. Dismiss the welcome modal on first login.
  4. Edit display name on the profile page (optional, any time after first login).
- **User journey touchpoints:**
  - Public landing page (visible to all visitors)
  - Microsoft OAuth flow (Microsoft-hosted; branded with Microsoft + Nortal via Entra app branding)
  - Participant dashboard (post-authentication)
  - Profile page (accessed from header / user menu)
  - `/access-denied` page (eligibility rejection; publicly reachable)
  - `/auth-error` page (recoverable provider / callback failures; publicly reachable with **Retry** CTA)
  - `/privacy` page (data-collection notice; publicly reachable; linked from landing page and welcome modal)
- **Accessibility needs:**
  - Sign-in button keyboard-accessible; announces its purpose to screen readers
  - Welcome modal traps focus while open, dismissible with Esc, announces content
  - `/access-denied` clearly explains the rejection reason and offers a non-dead-end exit
- **Usability considerations:**
  - Single-click sign-in (no registration step) eliminates the most common drop-off point
  - Welcome modal explains scoring once; users who dismiss it can find scoring rules elsewhere (linked in dashboard footer)
  - Profile page discoverable but not in-your-face (typical "click your name in the header" pattern)
- **Localization:**
  - All user-visible copy provided in three languages: English (`en`), Spanish (`es`), Brazilian Portuguese (`pt-BR`)
  - Language auto-detected from browser `Accept-Language` header with English fallback
  - User-pick language override is post-MVP (deferred)

---

## 10. Integration Context

**External Systems:**

- **Microsoft Entra ID (Azure AD):**
  - **Business purpose:** Authoritative identity provider for Nortal collaborators; the only sanctioned mechanism for verifying Nortal employment.
  - **Data exchange:** OAuth 2.0 authorization-code flow. App receives a JWT containing `oid`, `tid`, `email`, and `name` claims. App requests `openid email profile` scopes; no Microsoft Graph API access is required for MVP.
  - **Timing:** Synchronous during user sign-in; every session.

- **Supabase Auth:**
  - **Business purpose:** OAuth callback handling, JWT validation, session management.
  - **Data exchange:** Receives the Microsoft OAuth callback; issues an app session carrying the Microsoft claims; manages refresh tokens.
  - **Timing:** Synchronous during sign-in; refresh-token cycle for session renewal.

**Integration Constraints:**
- App must operate without Microsoft Graph API access for MVP (per Q2 resolution — no region fetch).
- The Nortal Entra tenant ID MUST be supplied via configuration before the app can validate any sign-in (fail-closed).
- The Microsoft / Azure OAuth provider MUST be configured in Supabase Auth with `client_id` and `client_secret` from Nortal IT (OD-007 follow-up #2).

---

## 11. Feature-Specific Constraints

**FC-1: Fail-closed on missing configuration**
- **Description:** If `nortal_tenant_id` is not configured at sign-in time, eligibility MUST fail for all users (no fallback / open-by-default behaviour).
- **Impact:** Deployment runbook must verify the value is set before the first user signs in. The initial migration MUST require the value to be present (e.g., `NOT NULL` constraint on the configuration row).

**FC-2: No participant row for ineligible users (ever)**
- **Description:** Under no circumstances should an ineligible user's sign-in attempt create a participant row. Eligibility check MUST execute before any participant insert (or both in a single transaction with rollback on rejection).
- **Impact:** Provisioning logic ordering matters; an integration test must verify no row is created for an ineligible attempt.

**FC-3: No automatic OAuth retry loop**
- **Description:** The **Retry** CTA on `/auth-error` MUST always be a user-initiated action that starts a fresh OAuth flow. There MUST NOT be silent / automatic client-side retries that could loop indefinitely or amplify load on a degraded provider.
- **Impact:** During Microsoft Entra incidents, retries are spread out by individual user choice rather than concentrated by client-side timers.

### Feature-Specific Assumptions

**FA-1:** Nortal IT will create a Microsoft OAuth app registration in their Entra tenant for this pool.
- Required to obtain the `client_id` / `client_secret` that Supabase Auth needs.
- **Validation plan:** OD-007 sub-condition #2 (Entra ID integration spike) covers this. Cannot start integration testing without it.

**FA-2:** The JWT will carry `oid`, `tid`, `email`, and `name` claims when the user signs in with `openid email profile` scopes.
- These are standard Microsoft Entra claims for an authenticated user.
- **Validation plan:** Confirmed during the Entra ID integration spike.

**FA-3:** The Nortal Entra tenant contains fewer than 10,000 eligible users.
- Affects eligibility-check performance assumptions and participant-table sizing.
- **Validation plan:** Confirm with Nortal IT; revisit indexing on `oid` lookups if significantly higher.

**FA-4:** The legal basis for processing participants' personal data (corporate email, display name) is **legitimate interest** under the Nortal employment context — not consent.
- Voluntary participation in an internal pool does not require explicit GDPR-style consent capture; the privacy notice (FR-A10) satisfies the transparency obligation under architecture §11.3.
- **Validation plan:** Confirm with Nortal Privacy / Legal team before launch. If they require consent-based processing instead, revisit C3 and add consent-capture infrastructure (`participants.privacy_accepted_at`, policy versioning, re-consent on policy change).

---

## 12. References

**Project Context:**
- Constitution: `.ai_project_memory/constitution.md`
- Architecture: `.ai_project_memory/architecture.md`
- General overview: `.ai_project_memory/general-overview.md`
- Backend constitution: `.ai_project_memory/constitution-backend.md`
- Frontend constitution: `.ai_project_memory/constitution-frontend.md`

**Related Specifications:** *(none — this is the first feature spec)*

**External References:**
- Nortal World Cup 2026 Prediction Pool architecture: `project-repos/world-cup-madness/docs/architecture/high-level-architecture.md` (FR-001, FR-002, FR-003, §11.1, §11.3)
- Open-decisions resolutions: `project-repos/world-cup-madness/docs/architecture/open-decisions.md` (OD-001, OD-007)
- Stack decision (Approved): `project-repos/world-cup-madness/docs/architecture/stack-decision.md`
- Microsoft identity platform docs: https://learn.microsoft.com/en-us/entra/identity-platform/
- Supabase Auth — Azure provider: https://supabase.com/docs/guides/auth/social-login/auth-azure

---

## Review & Acceptance Checklist

### Content Quality
- [x] No incidental implementation details (technology references retained only where committed by approved architectural decisions OD-001 / OD-007)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

### Traceability & Context
- [x] Architecture spec (FR-001/002/003) linked
- [x] OD-001 and OD-007 resolutions linked
- [x] All clarifications documented with dates
- [x] Deferred decisions documented with rationale and resolution phase

---

## Execution Status

- [x] User description parsed
- [x] Key concepts extracted
- [x] Ambiguities resolved via Socratic dialogue (2 rounds, 8 questions)
- [x] User scenarios defined
- [x] Requirements generated (FR-001 through FR-A7 + NFR-A1–A4)
- [x] Entities identified
- [x] Review checklist passed
