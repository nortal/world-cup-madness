# Open Decisions

Extracted from §17.2 of [`high-level-architecture.md`](high-level-architecture.md). Each decision blocks part of the build until resolved.

## Status

All eight decisions **Resolved 2026-05-15**.

## Decision Log

### OD-001 — Approved email domains

**Question.** What exact Nortal domains or identity tenants are eligible?
**Owner.** Security / business sponsor
**Affects.** FR-001 (eligibility), FR-002 (rejected external access), FR-020 (configuration)
**Status.** Resolved 2026-05-15
**Resolution.** Eligibility is determined by **Nortal Entra ID tenant membership** (`tid` claim in the OAuth token), not by email domain alone. This means:

- Any user inside the Nortal Entra ID tenant is eligible, regardless of their primary email domain — this covers `@nortal.com`, country-variant `@nortal.*` addresses, and guest accounts that Nortal IT has explicitly provisioned in the Nortal tenant.
- Users outside the Nortal Entra ID tenant are rejected at the OAuth boundary even if they can authenticate with Microsoft.

**Implementation implication.** The Postgres trigger / RLS policy on `participants` validates the `tid` claim (Nortal tenant ID) on every authenticated session, not just the email domain string. The exact tenant ID value must be obtained from Nortal IT and stored as a configuration value (FR-020).

**Follow-up.** Obtain the Nortal Entra tenant ID from Nortal IT before Phase 1 implementation.

### OD-002 — Official score basis for knockouts

**Question.** For knockout matches, should predictions be evaluated on regular time, extra time included, or another official score basis?
**Owner.** Business sponsor / rules owner
**Affects.** FR-011 (scoring), FR-018 (audit), all knockout-round scoring scenarios
**Status.** Resolved 2026-05-15
**Resolution.** **Regular time (90 min + injury time) only.** Predictions are scored against the 90-minute result regardless of whether the knockout match goes to extra time or penalty shootouts. Extra time and shootouts are tournament-progression events but do not change the predicted-score evaluation.

**Implementation implication.** The `match_results` table stores the 90-min `home_score` / `away_score`; `calculate_match_points()` operates on these fields only. The provider integration (football-data.org via Edge Function) must normalize the post-90-min "regular time" score into these fields, ignoring any ET or penalty totals exposed by the provider.

**User communication.** The prediction UI must explicitly state "predictions are scored against the result at 90 minutes" so users do not assume ET / penalties matter.

### OD-003 — Penalty shootouts

**Question.** Are penalty shootout scores excluded from score predictions?
**Owner.** Business sponsor / rules owner
**Affects.** FR-005 (prediction entry UX), FR-011 (scoring), data model for matches
**Status.** Resolved 2026-05-15
**Resolution.** **Penalty shootouts are excluded** from the predicted score. Predictions are score-only (predicted home goals vs predicted away goals from regular time per OD-002). Penalty shootouts never contribute to scoring.

**Implementation implication.** No `penalty_home` / `penalty_away` fields in the `match_results` table. The prediction UI shows only two integer inputs (home score, away score) — no conditional penalty inputs. Edge cases such as a knockout match decided on penalties are reported in the UI as "0–0 (decided on penalties)" but the prediction is scored against `0–0`.

### OD-004 — Top scorer ties

**Question.** If multiple players share top scorer status, should all be accepted as correct, or does an official tiebreaker rule pick one?
**Owner.** Business sponsor / rules owner
**Affects.** FR-012 (final prediction scoring)
**Status.** Resolved 2026-05-15
**Resolution.** **FIFA's official Golden Boot tiebreakers apply.** Only the player officially awarded the FIFA Golden Boot is the correct top scorer. FIFA's standard tiebreaker order is: (1) most goals, (2) most assists, (3) fewest minutes played. Predictions naming a player tied on goals but not awarded the Golden Boot score 0 points.

**Implementation implication.** The `final_predictions` scoring step (`calculate_final_prediction_points()`) compares the predicted `top_scorer_player_id` against a single `awarded_top_scorer_player_id` stored on the tournament record. Admin sets the awarded player via FR-015 once FIFA announces the winner.

**User communication.** The final-prediction UI explicitly states that FIFA's official Golden Boot decision determines the correct answer in case of a tie.

### OD-005 — Best player source

**Question.** Which official source determines the tournament best player?
**Owner.** Business sponsor / admin owner
**Affects.** FR-012 (final prediction scoring), FR-017 (provider integration)
**Status.** Resolved 2026-05-15
**Resolution.** **Adidas Golden Ball (FIFA Player of the Tournament).** The single player awarded the Adidas Golden Ball at the closing ceremony is the correct answer for the "best player" final prediction.

**Implementation implication.** The `final_predictions` scoring step compares the predicted `best_player_id` against a single `awarded_best_player_id` stored on the tournament record. Admin sets the awarded player via FR-015 once FIFA announces the winner at the closing ceremony.

**Provider note.** football-data.org may not expose Golden Ball data on its free tier. The admin manual-entry path (FR-015) is the primary source of truth for this value — provider integration is best-effort, not required.

### OD-006 — Leaderboard visibility

**Question.** Can all participants see all names, or should visibility be limited (e.g. anonymized below top-N, or scoped to office/team)?
**Owner.** Privacy / business sponsor
**Affects.** FR-013 (leaderboard), FR-014 (personal breakdown), engagement features (team/office leagues)
**Status.** Resolved 2026-05-15
**Resolution.** **Display name + points visible to all participants; corporate email visible only to administrators.** Matches the privacy note in §11.3. Optional team/office grouping is deferred to post-MVP and requires a separate privacy review.

**Implementation implication.** RLS policy on the `participants` view used by the leaderboard exposes `display_name` and `total_points` columns to authenticated participants; the `corporate_email` column is gated to the `admin` role only. The leaderboard query joins `leaderboard_snapshots` against this RLS-filtered view.

**Privacy notice.** Pre-launch communications must state that display name and points are visible to all eligible Nortal participants.

### OD-007 — Implementation approach

**Question.** Which technology stack or platform will be selected after evaluating options?
**Owner.** Architecture board / engineering
**Affects.** All NFRs, hosting, deployment, secret management, identity integration
**Status.** Resolved 2026-05-15
**Resolution.** **Approved as proposed in [`stack-decision.md`](stack-decision.md):**

- **Frontend:** Next.js (App Router) + React + TypeScript + Tailwind CSS, hosted on Vercel
- **Backend:** Supabase — Postgres + PostgREST + Auth + Realtime + Edge Functions
- **Identity:** Supabase Auth with Microsoft/Azure OAuth (Entra ID), tenant-based eligibility per OD-001
- **Authorization:** Row-Level Security (RLS) policies in Postgres
- **External data:** football-data.org via Supabase Edge Function (provider-agnostic abstraction)

**Sub-conditions tracked as follow-ups** (not blocking the resolution):

1. Security review of OAuth + tenant-allowlist approach with Nortal Security — before Phase 1 production cutover
2. Validate Microsoft/Azure OAuth integration with Nortal's Entra ID tenant — Phase 1 spike
3. Pro-tier Supabase upgrade ($25/mo) budget approved for tournament window (June–July 2026) — before Phase 5 (operational readiness)
4. Architecture board minute documenting the decision — capture separately if required by governance

See [`stack-decision.md`](stack-decision.md) for full rationale, tradeoffs, and cost profile.

### OD-008 — Notification channels

**Question.** Which internal channels (Slack, Teams, email, in-app) are approved for reminders and announcements?
**Owner.** Business sponsor / communications
**Affects.** FR-019 (notifications), engagement enhancements (deadline reminders)
**Status.** Resolved 2026-05-15
**Resolution.** **In-app for MVP, Microsoft Teams as the external channel (post-MVP).** Email and Slack are out of scope.

- **MVP scope (Phase 1–3):** In-app surfaces only — dashboard banners, lock-countdown chips, missed-prediction alerts.
- **Post-MVP (Phase 4):** Microsoft Teams integration for deadline reminders and tournament announcements via a Teams webhook or app. Natural fit with the Microsoft 365 / Entra ID identity stack chosen in OD-001 / OD-007.
- **Out of scope:** Email transactional notifications. Slack workspace integration.

**Implementation implication.** No external notification dependencies for MVP launch. Phase 4 work requires Nortal IT to register a Teams app or webhook and provide the webhook URL as a Supabase project secret. The notification service is a Supabase Edge Function that the scheduler invokes before each match lock window.

## How to use this file

When resolving a decision:

1. Update **Status** to one of: Open / In review / Resolved / Deferred / Wontfix.
2. Fill in **Resolution** with the decision and a brief rationale.
3. Reference any commit, PR, or external document that captures the decision.
4. Cross-link affected FRs in the build if the resolution changes scope.
