**Nortal World Cup 2026  
Prediction Pool**

**Technology-Agnostic High-Level Architecture and Requirements
Specification**

Version 2.0 \| April 27, 2026

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th><p><strong>Architecture positioning</strong></p>
<p>This document intentionally avoids prescribing a single
implementation technology. It defines business capabilities,
architectural building blocks, integration patterns, controls, data
responsibilities, and decision criteria that can be implemented through
a custom web application, an enterprise low-code platform, a hybrid
model, or another approved internal technology stack.</p></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

| **Prepared for** | **Purpose** | **Primary audience** |
|----|----|----|
| Nortal internal collaborators and project stakeholders | Define a high-level architecture and detailed requirements baseline for a World Cup 2026 prediction pool application. | Business sponsors, solution architects, product owners, engineering teams, security reviewers, operations, and administrators. |

# Document Control

| **Attribute** | **Value** |
|----|----|
| Document title | Nortal World Cup 2026 Prediction Pool - Technology-Agnostic High-Level Architecture and Requirements Specification |
| Version | 2.0 |
| Date | April 27, 2026 |
| Language | English |
| Status | Draft for architectural review |
| Technology posture | Technology-agnostic. No single product, vendor, framework, or platform is mandated by this architecture. |
| Scope level | High-level architecture plus detailed functional, non-functional, data, security, and operational requirements. |

## Recommended Reviewers

- Business sponsor or engagement owner responsible for the internal
  employee experience.

- Solution architect responsible for validating the logical architecture
  and integration model.

- Security and identity reviewer responsible for corporate-domain access
  restrictions and auditability.

- Engineering lead responsible for implementation feasibility,
  testability, and maintainability.

- Operations owner responsible for monitoring, support, incident
  response, and data correction procedures.

- Tournament administrator representative responsible for validating
  rules, scoring, leaderboards, and manual override needs.

# Table of Contents

- 1\. Executive Summary

- 2\. Vision, Objectives, and Success Criteria

- 3\. Architecture Principles

- 4\. Stakeholders and Personas

- 5\. Scope, Assumptions, and Constraints

- 6\. Functional Requirements

- 7\. Business Rules and Scoring Model

- 8\. High-Level Architecture

- 9\. Data Architecture

- 10\. Integration Architecture

- 11\. Security and Privacy Architecture

- 12\. Non-Functional Requirements

- 13\. Administration, Operations, and Observability

- 14\. User Experience and Engagement Considerations

- 15\. Quality Assurance and Acceptance Criteria

- 16\. Delivery Roadmap

- 17\. Risks, Mitigations, and Open Decisions

- 18\. Glossary and References

# 1. Executive Summary

Nortal intends to build an internal World Cup 2026 prediction pool
application for collaborators. The product should provide a secure,
engaging, fair, and auditable experience where eligible users can submit
match-by-match predictions, submit final tournament predictions, track
points, and compare their performance through leaderboards during the
tournament.

The architecture must not be tied to a single implementation technology.
Instead, it should be defined around business capabilities and logical
components: user experience, corporate identity enforcement, prediction
management, rules and scoring, official match data synchronization,
administrative controls, reporting, audit trail, monitoring, and
operational support.

The most important architectural concern is fairness. Prediction
deadlines, score updates, data corrections, and leaderboard calculations
must be deterministic, transparent, and auditable. All time-based rules
must rely on trusted server-side time and official match kickoff
timestamps stored in a normalized time zone. User device time must never
be used to decide whether a prediction is still editable.

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th><p><strong>Key change from the previous approach</strong></p>
<p>The application should not be presented as a Power Apps-only solution
or any other single-product solution. A low-code implementation, a
custom web application, a hybrid model, or another approved internal
platform may all be valid depending on Nortal's governance, delivery
timeline, budget, licensing, security posture, and expected user
adoption.</p></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## 1.1 Architectural Intent

- Provide a high-level architecture that can be implemented using
  multiple technology stacks without changing the business rules.

- Separate business rules from presentation logic so scoring and locking
  rules remain consistent across web, mobile, administrative, and
  integration channels.

- Abstract the football data provider behind an integration layer so the
  solution can start with a free or low-cost API and later switch to a
  paid or more reliable provider if needed.

- Ensure that only Nortal collaborators with approved corporate domains
  can access the application.

- Design for tournament traffic peaks, especially shortly before match
  lock times and immediately after final scores are published.

## 1.2 Recommended Architectural Direction

The recommended direction is a modular, provider-agnostic application
architecture. The application should expose a single consistent
experience to collaborators while internally separating user access,
prediction capture, scoring, data synchronization, administration, and
reporting into well-defined logical services or modules. This does not
require microservices; it requires clear separation of responsibilities.

| **Architectural capability** | **Purpose** | **Why it matters** |
|----|----|----|
| Corporate access boundary | Authenticate users and verify they belong to the allowed Nortal domain or approved Nortal identity tenant. | Prevents participation from external email addresses and protects internal engagement data. |
| Prediction management | Allow users to create and update match predictions while respecting lock windows. | Core product value; must be reliable and easy to use under time pressure. |
| Tournament final predictions | Allow predictions for top scorer, best player, champion, and runner-up before the first match starts. | Creates long-term engagement and additional scoring mechanics. |
| Rules and scoring engine | Apply scoring rules consistently for exact score, winner/draw, and final prediction items. | Prevents disputes and allows recalculation if official data changes. |
| Match data integration | Synchronize fixtures, kickoff times, statuses, and final scores from one or more trusted sources. | Reduces manual work and keeps the pool aligned with official results. |
| Leaderboard and analytics | Present rankings, personal progress, match-level points, and summary statistics. | Drives engagement and transparency. |
| Administration and operations | Support configuration, manual corrections, audits, and tournament monitoring. | Provides resilience when APIs fail or match data requires correction. |

# 2. Vision, Objectives, and Success Criteria

## 2.1 Product Vision

The product vision is to create a secure internal competition that
increases employee engagement during the FIFA World Cup 2026 while
remaining simple enough for broad adoption and robust enough to
withstand tournament-specific edge cases.

## 2.2 Business Objectives

| **Objective** | **Description** | **Success indicator** |
|----|----|----|
| Engagement | Encourage Nortal collaborators to participate before and throughout the tournament. | High registration rate, repeated visits, and prediction completion rate. |
| Fairness | Ensure all participants are subject to identical deadlines and scoring rules. | No confirmed disputes caused by inconsistent locks or score calculations. |
| Transparency | Make points, prediction locks, and leaderboard calculations understandable. | Users can explain why they received a specific score. |
| Security | Restrict access to eligible Nortal users only. | No successful login or registration with non-approved domains. |
| Operational reliability | Handle match-day updates, API limitations, and manual correction scenarios. | Scores and leaderboards update within agreed service targets. |
| Extensibility | Allow future tournaments, rule changes, or regions without complete redesign. | Reusable data model and rules configuration for future events. |

## 2.3 Success Criteria

- Eligible users can access the application using approved Nortal
  identity credentials only.

- Users can submit predictions for upcoming matches until the
  match-specific lock window starts.

- Users can edit predictions only when the match has not started and
  more than one hour remains before kickoff.

- Users can submit final tournament predictions only before the first
  official tournament match begins.

- Scores are calculated consistently using an auditable scoring model.

- Leaderboard updates are timely, transparent, and resilient to external
  data provider delays.

- Administrators can manage tournament configuration, monitor data
  synchronization, correct official score data when justified, and
  trigger recalculation.

- The architecture can be implemented by multiple technologies without
  changing the business requirements.

# 3. Architecture Principles

| **Principle** | **Definition** | **Implication** |
|----|----|----|
| Technology neutrality | The architecture must define capabilities, responsibilities, and interfaces without mandating a specific implementation product. | Implementation teams should evaluate platform options separately through objective criteria. |
| Security by design | Access restrictions must be enforced server-side and at the identity boundary, not only in the user interface. | The application must validate domain eligibility on every authenticated session and critical operation. |
| Rules outside the UI | Locking, editability, and scoring logic must be centralized and reusable. | Users cannot bypass rules by manipulating the front-end or direct API calls. |
| Provider abstraction | External football data providers should be hidden behind a stable integration contract. | A provider can be replaced if coverage, cost, reliability, or licensing changes. |
| Auditability | Every prediction, edit, score calculation, override, and administrative action must be traceable. | Disputes can be resolved using historical evidence rather than assumptions. |
| Time-zone correctness | All deadlines must use normalized kickoff timestamps and trusted server time. | Local display can vary by user, but locking decisions must be consistent globally. |
| Operational resilience | The system should continue operating even if the external score provider is delayed or temporarily unavailable. | Manual correction and retry mechanisms are required. |
| Extensibility | Tournament, scoring, and eligibility settings should be configurable where reasonable. | Future editions or internal tournaments should not require rebuilding the product. |

# 4. Stakeholders and Personas

| **Persona** | **Primary goals** | **Key needs** |
|----|----|----|
| Participant / collaborator | Submit predictions, track points, view leaderboards, and compare results with colleagues. | Fast login, clear deadlines, easy prediction entry, transparent scoring, mobile-friendly experience. |
| Tournament administrator | Configure tournament data, resolve issues, manage overrides, and supervise scoring. | Admin dashboard, manual correction workflow, audit logs, recalculation controls, clear exception handling. |
| Business sponsor | Drive engagement and ensure the experience reflects Nortal's culture. | Adoption metrics, communications support, fairness, positive user feedback. |
| Solution architect | Ensure the application is maintainable, secure, scalable, and independent from unnecessary vendor lock-in. | Clear component boundaries, data ownership, integration contracts, NFRs. |
| Security reviewer | Validate access control, domain enforcement, privacy, and audit capabilities. | Identity controls, authorization model, logging, data retention, risk mitigations. |
| Operations/support owner | Monitor production behavior, respond to incidents, and support users during the tournament. | Health dashboards, alerts, runbooks, support procedures, recovery steps. |

# 5. Scope, Assumptions, and Constraints

## 5.1 In Scope

- Authentication and eligibility validation for Nortal collaborators.

- Participant registration or automatic profile provisioning after first
  eligible login.

- Match catalog for FIFA World Cup 2026 fixtures, including teams,
  dates, kickoff times, stage, group, status, and score fields.

- Submission and update of match score predictions before match lock
  deadlines.

- Submission and update of final tournament predictions before the first
  match begins.

- Scoring for match predictions and final tournament prediction items.

- Leaderboard views and personal scoring breakdowns.

- Administrative tools for configuration, data validation, manual
  correction, and recalculation.

- Integration with at least one external football data source, plus
  fallback/manual mechanisms.

- Audit, monitoring, reporting, and operational support requirements.

## 5.2 Out of Scope for Initial Release

- Paid betting, wagers, money pools, or gambling functionality.

- Public access for users outside Nortal's approved identity boundary.

- Complex social networking features unrelated to the prediction pool.

- Real-time live match commentary unless a later decision explicitly
  adds it.

- Full mobile native applications unless selected as part of the
  implementation strategy.

- Integration with payroll, HR performance systems, or sensitive
  employee records beyond basic corporate identity attributes.

## 5.3 Key Assumptions

| **Assumption** | **Architectural impact** |
|----|----|
| Nortal has an approved corporate identity mechanism for employees or collaborators. | The application should delegate authentication to the corporate identity boundary instead of storing passwords. |
| The allowed email domain or domains can be formally defined before launch. | Domain validation must be configurable, for example allowing a list such as @nortal.com and any other approved corporate domains. |
| The tournament schedule and official match times may change before or during the tournament. | Match data synchronization and administrative correction are mandatory capabilities. |
| External football APIs may have rate limits, delayed scores, limited free coverage, or licensing restrictions. | The solution must not depend on a single provider without fallback and caching. |
| User traffic will spike near match deadlines and after matches finish. | Critical paths must be optimized for read-heavy leaderboard traffic and deadline-sensitive prediction writes. |

## 5.4 Constraints

- No user with a non-approved Nortal email domain may access or
  participate in the application.

- Prediction locks must be based on server-side time and official
  kickoff time, not client-side time.

- The final tournament predictions must become immutable as soon as the
  first official World Cup 2026 match starts.

- The solution must preserve an audit trail of prediction changes and
  scoring recalculations.

- The architecture must allow different implementation technologies and
  should avoid product-specific requirements at this stage.

# 6. Functional Requirements

The following functional requirements define what the application must
do. They are intentionally written in technology-neutral language and
can be implemented through different delivery approaches.

| **ID** | **Area** | **Requirement** | **Priority** |
|----|----|----|----|
| FR-001 | Eligibility and access | The application shall allow access only to authenticated users whose identity belongs to an approved Nortal corporate domain or approved Nortal identity tenant. | Must have |
| FR-002 | Rejected external access | The application shall reject login, registration, and API access attempts from non-approved domains, even if the user can technically authenticate through a third-party identity provider. | Must have |
| FR-003 | Profile provisioning | The application shall create or update a participant profile after first successful eligible login, capturing only required business attributes such as display name, email, domain, region if available, and participation status. | Must have |
| FR-004 | Match catalog | The application shall maintain a catalog of World Cup 2026 matches with official identifiers, teams, stage, group, kickoff time, venue if available, status, and score fields. | Must have |
| FR-005 | Prediction entry | The application shall allow each participant to enter predictions for one or more upcoming matches. | Must have |
| FR-006 | Single active prediction per match | The application shall maintain only one active match prediction per participant per match, while preserving historical edits for audit purposes. | Must have |
| FR-007 | Prediction update | The application shall allow a participant to update an existing match prediction only when the match has not started and more than one hour remains before kickoff. | Must have |
| FR-008 | Match lock | The application shall prevent creation or modification of a match prediction when the current trusted server time is equal to or later than the match kickoff time minus 60 minutes. | Must have |
| FR-009 | Final predictions | The application shall allow participants to submit predictions for top scorer, best player, champion team, and runner-up team before the first official tournament match begins. | Must have |
| FR-010 | Final prediction lock | The application shall prevent creation or modification of final tournament predictions once the first official World Cup 2026 match has started. | Must have |
| FR-011 | Score calculation | The application shall calculate match prediction points using the defined scoring rules for exact score, correct outcome, and incorrect prediction. | Must have |
| FR-012 | Final prediction scoring | The application shall award 20 points for each correctly predicted final tournament item: top scorer, best player, champion, and runner-up. | Must have |
| FR-013 | Leaderboard | The application shall provide a leaderboard ranked by total points, with deterministic tie-breaking rules. | Must have |
| FR-014 | Personal breakdown | The application shall provide each participant with a breakdown of points by match and by final prediction item. | Should have |
| FR-015 | Administrative override | The application shall allow authorized administrators to correct match data, final award data, or scoring inputs when official sources are delayed or incorrect. | Must have |
| FR-016 | Recalculation | The application shall allow authorized administrators or scheduled processes to recalculate points after match scores or official final tournament data changes. | Must have |
| FR-017 | Data synchronization | The application shall synchronize fixtures, statuses, and scores from one or more external football data providers through a provider-agnostic integration layer. | Should have |
| FR-018 | Audit trail | The application shall record creation, update, lock, override, and scoring events with timestamp, actor, previous value, new value, and reason where applicable. | Must have |
| FR-019 | Notifications | The application should notify participants about upcoming deadlines, missing predictions, score updates, and leaderboard milestones, subject to communication policy. | Should have |
| FR-020 | Configuration | The application shall allow administrators to configure tournament settings, allowed domains, lock windows, scoring values, active/inactive phases, and provider settings. | Must have |

## 6.1 Participant Journey Requirements

1.  The participant opens the application and is redirected to the
    corporate authentication flow.

2.  The system validates that the authenticated identity belongs to an
    approved Nortal domain or tenant.

3.  If the user is eligible, the system provisions or refreshes the
    participant profile.

4.  The participant lands on a dashboard showing upcoming unlocked
    matches, locked matches, submitted predictions, missing predictions,
    and current points.

5.  The participant enters one or more score predictions for matches
    that are still editable.

6.  The participant optionally enters final tournament predictions
    before the first match starts.

7.  The participant can update predictions until the applicable lock
    rules prevent modifications.

8.  After matches finish and official scores are synchronized or
    approved, the participant can see awarded points and leaderboard
    position.

## 6.2 Administrator Journey Requirements

9.  The administrator signs in through the same corporate identity
    boundary and receives access only if assigned an administrative
    role.

10. The administrator reviews tournament configuration, match schedule,
    provider synchronization status, and error logs.

11. The administrator validates match score updates from external
    providers or manually corrects them when required.

12. The administrator triggers or approves score recalculation when
    official data changes.

13. The administrator reviews audit records for disputes, late edits, or
    scoring issues.

14. The administrator publishes announcements or operational notices
    when relevant.

# 7. Business Rules and Scoring Model

## 7.1 Time and Locking Rules

| **Rule ID** | **Rule** | **Definition** |
|----|----|----|
| BR-LOCK-001 | Trusted time source | All lock decisions shall use trusted server-side time. Client device time shall never determine editability. |
| BR-LOCK-002 | Match prediction lock window | A match prediction is editable only when more than 60 minutes remain before the official kickoff time. |
| BR-LOCK-003 | Boundary condition | At exactly kickoff minus 60 minutes, the prediction becomes locked. The rule is strict: remaining time must be greater than 60 minutes to allow edits. |
| BR-LOCK-004 | Started match | No prediction can be created or modified after the match has started, even if an incorrect kickoff time was displayed to the user. Administrative correction may be required if schedule data was wrong. |
| BR-LOCK-005 | Final predictions | Final tournament predictions are editable only before the first official match kickoff. At first kickoff, champion, runner-up, top scorer, and best player predictions become immutable. |
| BR-LOCK-006 | Time zone handling | Kickoff times must be stored in UTC or another normalized canonical time standard and displayed according to user locale or configured tournament view. |

## 7.2 Match Prediction Scoring Rules

For every completed match with an official score, the application shall
evaluate the user's predicted score against the official score. The
baseline scoring model is defined below.

| **Scenario** | **Condition** | **Points** | **Example** |
|----|----|----|----|
| Exact score | Predicted home/team A score equals official home/team A score and predicted away/team B score equals official away/team B score. | 10 points | Predicted 2-1 and official result is 2-1. |
| Correct outcome only | Predicted outcome matches official outcome but exact score does not match. Outcome means home/team A win, draw, or away/team B win. | 5 points | Predicted 3-2 and official result is 2-1: user correctly predicted team A would win but not the exact score. |
| Incorrect outcome | Predicted outcome does not match the official outcome. | 0 points | Predicted 1-0 but official result is 0-1. |
| No valid prediction | No prediction was submitted before lock, or prediction was invalidated by an administrative decision. | 0 points | User did not submit before the lock deadline. |

## 7.3 Final Tournament Prediction Scoring Rules

| **Item** | **Condition** | **Points** |
|----|----|----|
| Champion team | User predicted the tournament champion correctly. | 20 points |
| Runner-up team | User predicted the team that finishes second correctly. | 20 points |
| Top scorer | User predicted the official tournament top scorer correctly according to the approved source or business-defined tie rule. | 20 points |
| Best player | User predicted the official tournament best player correctly according to the approved source. | 20 points |

## 7.4 Tie-Breaking Rules for Leaderboards

The business should approve deterministic tie-breakers before launch.
The following default order is recommended because it rewards prediction
quality while remaining explainable:

15. Highest total points.

16. Highest number of exact-score hits.

17. Highest number of correct-outcome hits.

18. Highest final tournament prediction points.

19. Earliest timestamp of last valid prediction submission, only if a
    final tie-breaker is required and approved.

20. Shared rank if all configured tie-breakers remain equal.

## 7.5 Important Rule Clarifications

| **Topic** | **Clarification** |
|----|----|
| Official score basis | The project must define whether knockout predictions use regular time, extra time, or the official final score excluding penalty shootouts. This is a critical pre-launch decision. |
| Penalty shootouts | Penalty shootouts should not be assumed to be part of the predicted score unless explicitly stated to users. If included, UI and data model must support it. |
| Abandoned or postponed matches | If a match is postponed, the lock time should follow the corrected kickoff time unless the original match had already locked and business decides otherwise. |
| Provider data changes | If a provider changes a score after recalculation, the application must preserve the prior calculation and record a new recalculation event. |
| Top scorer ties | If multiple players share top scorer status, business must decide whether all are accepted as correct or whether official award rules determine one winner. |
| Best player source | The source of the official best player award must be determined before final scoring. |

# 8. High-Level Architecture

The application should be designed around logical capabilities. These
capabilities may be deployed as one application, a modular monolith,
separate services, serverless functions, workflow automations, or a
hybrid architecture. The architecture does not require a specific
implementation style, but it does require clear ownership of rules,
data, security, and operations.

## 8.1 Logical Architecture Diagram

<table>
<colgroup>
<col style="width: 33%" />
<col style="width: 33%" />
<col style="width: 33%" />
</colgroup>
<thead>
<tr>
<th style="text-align: center;"><strong>Participant Experience<br />
Web / mobile-friendly UI</strong></th>
<th style="text-align: center;"><strong>Corporate Identity
Boundary<br />
SSO + domain / tenant eligibility</strong></th>
<th style="text-align: center;"><strong>Administrator Experience<br />
Configuration, overrides, monitoring</strong></th>
</tr>
</thead>
<tbody>
<tr>
<td style="text-align: center;"><strong>Application/API Boundary<br />
Validation, authorization, session enforcement</strong></td>
<td style="text-align: center;"><strong>Business Rules Layer<br />
Locking, scoring, ranking, recalculation</strong></td>
<td style="text-align: center;"><strong>Notification &amp; Engagement
Layer<br />
Reminders, announcements, updates</strong></td>
</tr>
<tr>
<td style="text-align: center;"><strong>Prediction Management<br />
Match predictions and final predictions</strong></td>
<td style="text-align: center;"><strong>Tournament Data Management<br />
Fixtures, teams, match statuses, official results</strong></td>
<td style="text-align: center;"><strong>Leaderboard &amp;
Analytics<br />
Rankings, personal breakdowns, reports</strong></td>
</tr>
<tr>
<td style="text-align: center;"><strong>Transactional Data Store<br />
Participants, predictions, scores, audit</strong></td>
<td style="text-align: center;"><strong>Integration Layer<br />
Provider abstraction, sync, retries, manual fallback</strong></td>
<td style="text-align: center;"><strong>Observability &amp;
Operations<br />
Logs, metrics, alerts, runbooks</strong></td>
</tr>
<tr>
<td style="text-align: center;"><strong>External Football Data
Provider(s)<br />
Schedules, fixtures, scores, awards</strong></td>
<td style="text-align: center;"><strong>Governance Controls<br />
Security, privacy, retention, compliance</strong></td>
<td style="text-align: center;"><strong>Future Extensions<br />
New tournaments, teams, regions, gamification</strong></td>
</tr>
</tbody>
</table>

Figure 1. Logical high-level architecture. The diagram shows
responsibilities, not implementation products.

## 8.2 Component Responsibilities

| **Component** | **Responsibility** | **Architectural requirement** |
|----|----|----|
| Participant experience | Provides the user interface for viewing matches, submitting predictions, seeing locks, checking scores, and viewing leaderboards. | Must not contain authoritative lock or scoring logic; it should call server-side capabilities. |
| Corporate identity boundary | Authenticates users and confirms corporate eligibility. | Must reject external domains and avoid local password storage. |
| Application/API boundary | Exposes secure operations for predictions, leaderboards, profile data, and administrative workflows. | Must validate authorization and business rules on every write operation. |
| Business rules layer | Owns prediction editability, final prediction locks, scoring, ranking, and recalculation logic. | Should be testable independently from the UI. |
| Prediction management | Stores and retrieves match predictions and final predictions. | Should support version history or audit logging for edits. |
| Tournament data management | Stores teams, matches, schedule, statuses, results, and final award values. | Must support provider updates and administrative corrections. |
| Integration layer | Synchronizes data from external providers and normalizes it into the internal data model. | Must handle rate limits, retries, provider outages, and data drift. |
| Leaderboard and analytics | Aggregates user points, ranking positions, trends, and reports. | Should support efficient reads during traffic spikes. |
| Administration | Enables configuration, manual correction, recalculation, and dispute support. | Must be role-protected and fully audited. |
| Observability | Collects logs, metrics, alerts, and operational traces. | Must allow rapid incident diagnosis during match windows. |

## 8.3 Candidate Implementation Patterns Without Technology Commitment

| **Pattern** | **Strengths** | **Limitations** | **When to consider** |
|----|----|----|----|
| Enterprise low-code internal app | Fast delivery, easier internal administration, strong fit if corporate identity and data governance are already available. | Can become constrained by complex rules, performance needs, advanced UI, or licensing limits. | Good for MVP if user volume and customization needs are moderate. |
| Custom web application | Maximum flexibility, strong control over UX, performance, testing, integration abstraction, and future extensibility. | Requires more engineering capacity, hosting decisions, CI/CD, and production support maturity. | Good for long-term product quality or high engagement expectations. |
| Hybrid model | Combines rapid administrative/configuration surfaces with custom user-facing or scoring components. | Requires careful integration boundaries and ownership clarity. | Good when speed and robust custom logic are both important. |
| Managed third-party pool platform | Potentially fastest launch if it supports corporate SSO, custom scoring, and private access. | May not satisfy domain restrictions, custom rules, audit, data privacy, or branding needs. | Useful only if governance accepts the data/privacy model. |

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th><p><strong>Decision guidance</strong></p>
<p>The implementation approach should be selected through an
architecture decision record that compares delivery speed, security,
licensing, maintainability, user experience, integration flexibility,
operational ownership, and tournament risk. The business rules in this
document should remain stable regardless of the selected
technology.</p></th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# 9. Data Architecture

The data architecture should separate participant data, tournament
reference data, predictions, scoring outputs, audit records, and
integration telemetry. This separation improves security,
maintainability, reporting, and recalculation.

## 9.1 Logical Data Entities

| **Entity** | **Purpose** | **Representative attributes** | **Notes** |
|----|----|----|----|
| Participant | Represents an eligible Nortal collaborator participating in the pool. | ParticipantId, corporateEmail, displayName, domain, status, createdAt, lastLoginAt | Corporate email should be unique after normalization. |
| Tournament | Represents the World Cup 2026 event and configuration. | TournamentId, name, startDateUtc, finalDateUtc, activePhase, lockWindowMinutes | Allows future reuse for other tournaments. |
| Team | Represents a national team. | TeamId, providerTeamId, name, shortName, countryCode, group | Provider IDs should not be the only internal keys. |
| Player | Represents a player eligible for top scorer or best player predictions. | PlayerId, providerPlayerId, fullName, teamId, aliases | Alias handling is important for manual entries. |
| Match | Represents a scheduled football match. | MatchId, providerMatchId, teams, stage, group, kickoffUtc, status, venue | Kickoff time changes must be versioned or audited. |
| MatchResult | Represents official match result values used for scoring. | MatchResultId, matchId, homeScore, awayScore, resultStatus, source, approvedAt | Should distinguish provider data from approved scoring data. |
| MatchPrediction | Represents a participant's predicted score for a match. | PredictionId, participantId, matchId, predictedHomeScore, predictedAwayScore, submittedAt, version | One active prediction per participant per match; history required. |
| FinalPrediction | Represents champion, runner-up, top scorer, and best player prediction set. | FinalPredictionId, participantId, championTeamId, runnerUpTeamId, topScorerPlayerId, bestPlayerId | Editable only before tournament start. |
| ScoreEvent | Represents awarded points for a prediction or recalculation event. | ScoreEventId, participantId, matchId/itemId, points, reason, calculatedAt, calculationRunId | Supports audit and recalculation history. |
| LeaderboardSnapshot | Represents ranking values generated at a point in time. | SnapshotId, participantId, rank, totalPoints, exactHits, outcomeHits, generatedAt | Can improve performance and historical reporting. |
| AuditLog | Represents security, data, administrative, and scoring events. | AuditId, actorId, action, entityType, entityId, oldValue, newValue, timestamp, reason | Must be tamper-resistant and searchable. |
| IntegrationRun | Represents scheduled or manual provider synchronization attempts. | RunId, provider, startedAt, endedAt, status, recordsProcessed, errors | Critical for operations and incident diagnosis. |

## 9.2 Data Ownership Rules

- Participant identity attributes originate from the corporate identity
  boundary and should not be manually edited except for
  application-specific fields such as display preference or
  participation status.

- Tournament schedule and team metadata originate from approved football
  data sources but must be normalized into the internal model.

- Predictions are user-owned records but governed by server-side lock
  rules.

- Scores are system-generated records but may be recalculated when
  official data changes.

- Administrative corrections must not overwrite history silently; they
  must create auditable change records.

- External provider identifiers should be stored for traceability but
  should not replace stable internal identifiers.

## 9.3 Data Quality Requirements

| **Requirement** | **Description** |
|----|----|
| Canonical time | All kickoff and lock calculations must use canonical timestamps. Display time may be localized, but the source of truth must be normalized. |
| Idempotent synchronization | Repeated imports of the same provider data should update the same internal match or team records rather than creating duplicates. |
| Version history | Prediction edits, kickoff changes, result corrections, and scoring recalculations must be traceable. |
| Validation | Predicted scores must be non-negative whole numbers within a reasonable configurable range. |
| Referential integrity | Predictions must reference valid participants and matches; final predictions must reference valid teams and players. |
| Data minimization | Only data needed for the pool should be stored. Sensitive HR data should not be imported. |

# 10. Integration Architecture

The application should integrate with football data through a
provider-agnostic integration layer. The application should not directly
bind UI screens, scoring logic, or data tables to a single external API
schema. This allows the project to start with one provider and later
introduce a backup or replacement provider without rewriting the
application core.

## 10.1 External Football Data Capabilities

- Fixture import: match identifiers, teams, groups, stages, venues, and
  kickoff times.

- Schedule change detection: updates to kickoff times, venues, or match
  status.

- Result synchronization: final score, match status, and completion
  indicators.

- Optional player data: scorers or squads if needed for top scorer
  prediction validation.

- Optional awards data: official best player source may need separate
  validation because not all football data APIs provide it reliably.

## 10.2 Provider-Agnostic Integration Pattern

21. A scheduled or event-driven integration job calls the selected
    football data provider using approved credentials and rate-limit
    controls.

22. Raw provider responses are captured or summarized for traceability,
    subject to licensing and storage policy.

23. A normalization step maps provider teams, matches, statuses, scores,
    and players into internal canonical entities.

24. The integration layer flags changes requiring administrative review,
    such as kickoff changes near lock windows or score corrections after
    scoring has already run.

25. The scoring engine consumes approved internal match result data, not
    raw external responses.

26. If the provider is unavailable or delayed, administrators can
    manually enter or approve official results through the
    administration interface.

## 10.3 Example Provider Consideration: football-data.org

football-data.org can be considered as an initial candidate data
provider because it exposes API resources for competitions and matches,
and its coverage page lists Worldcup/FIFA World Cup under the free tier.
However, this architecture should treat football-data.org as one
replaceable provider rather than a hard dependency.

| **Observation** | **Architectural implication** |
|----|----|
| The provider documents a v4 API and match resources that include competition, season, UTC date, status, teams, score-related data, and match metadata. | A normalization adapter can map provider match fields to the internal Match and MatchResult entities. |
| The provider lists a free plan with fixtures, delayed schedules, delayed scores, league tables, and 10 calls per minute. | Free-tier usage may be sufficient for MVP, but delayed scores and rate limits require caching, retries, and manual fallback. |
| The coverage page lists Worldcup / FIFA World Cup among free-tier competitions. | Coverage should still be verified with actual API access before launch and again shortly before the tournament. |
| Top scorer and best player data may require additional validation or a separate official source. | Final prediction scoring should not assume that one provider covers every award needed. |

## 10.4 Synchronization Frequency

| **Tournament phase** | **Suggested frequency** | **Rationale** |
|----|----|----|
| Before tournament | Daily, plus manual refresh after official schedule updates | Schedule changes are less frequent but still important before launch. |
| Match days before kickoff | Several times per day; more frequently near match windows | Detect kickoff changes and match statuses before locks. |
| During active match windows | Frequent polling if licensing permits; otherwise scheduled updates after expected full-time | The pool does not need live minute-by-minute data unless a future feature requires it. |
| After match completion | Run soon after full-time, then repeat later to detect corrections | Scores may be delayed or corrected. |
| After tournament | Final reconciliation and archive | Final awards and leaderboard closure require controlled validation. |

## 10.5 Integration Failure Handling

- Retry transient provider failures with backoff and rate-limit
  awareness.

- Do not repeatedly call the provider in a way that violates plan limits
  or risks account suspension.

- Alert administrators when synchronization fails, returns unexpected
  schema changes, or produces conflicting score updates.

- Allow manual result entry with reason and source evidence when
  provider data is unavailable.

- Support recalculation after delayed or corrected data is approved.

- Keep integration runs idempotent so reruns do not duplicate matches,
  teams, or results.

# 11. Security and Privacy Architecture

## 11.1 Access Control Requirements

| **Control** | **Requirement** |
|----|----|
| Authentication | Users must authenticate through an approved corporate identity boundary. The application should not store local passwords for participants. |
| Domain eligibility | The system must validate that the authenticated user belongs to an approved Nortal domain or approved Nortal tenant before allowing access. |
| Authorization | Roles must separate participants, administrators, support/audit readers, and system integration accounts. |
| Server-side enforcement | All business-critical access rules must be enforced server-side, not only through UI visibility. |
| Session controls | Sessions should follow corporate policy for expiration, refresh, revocation, and inactivity timeout. |
| Least privilege | Integration credentials and administrative permissions must have the minimum access required. |
| Audit | Authentication failures, domain rejections, administrative actions, prediction edits, score recalculations, and data corrections must be auditable. |

## 11.2 Domain Restriction Model

The domain restriction should be enforced in multiple layers to avoid
bypass scenarios:

27. Identity policy: restrict eligible sign-in where the corporate
    identity platform supports it.

28. Application authorization: validate the authenticated user's
    normalized email domain or tenant claim on every session and
    sensitive operation.

29. Registration guard: do not create participant profiles for external
    domains.

30. API guard: reject direct API attempts from ineligible identities.

31. Administrative report: log and surface rejected access attempts for
    security review if required by policy.

## 11.3 Privacy and Data Minimization

- Store only the participant data needed for the prediction pool, such
  as corporate email, display name, and optional region or office if
  approved.

- Do not import sensitive HR attributes, performance data, personal
  addresses, compensation, or private demographic attributes.

- Leaderboard visibility rules should be communicated before launch. For
  example, display name and points may be visible to all participants,
  while email may be hidden or limited to administrators.

- Define retention rules for predictions, scores, and audit logs after
  the tournament ends.

- Provide a clear privacy notice explaining what data is collected, why
  it is collected, who can see it, and how long it will be retained.

# 12. Non-Functional Requirements

| **ID** | **Category** | **Requirement** | **Priority** |
|----|----|----|----|
| NFR-001 | Availability | The application should be available during key tournament windows, especially one to two hours before each match and shortly after matches end. | High |
| NFR-002 | Performance | Common screens such as dashboard and leaderboard should load quickly under expected concurrent user traffic. | High |
| NFR-003 | Scalability | The architecture should handle spikes before lock deadlines without losing predictions or allowing late edits. | High |
| NFR-004 | Reliability | Prediction writes must be durable once confirmed to the user. | High |
| NFR-005 | Consistency | Lock rules and scores must be consistent across users, devices, and sessions. | High |
| NFR-006 | Security | Unauthorized and external-domain access must be prevented and logged. | Critical |
| NFR-007 | Auditability | The system must provide evidence for predictions, edits, locks, overrides, and scoring calculations. | High |
| NFR-008 | Maintainability | Rules and scoring values should be configurable or isolated enough to change without broad UI rewrites. | Medium |
| NFR-009 | Accessibility | The application should be usable with keyboard navigation, sufficient contrast, clear labels, and responsive layouts. | Medium |
| NFR-010 | Localization | The application must support English (en), Spanish (es), and Brazilian Portuguese (pt-BR) labels at launch, with browser locale auto-detection (Accept-Language) and English fallback. | High |
| NFR-011 | Observability | Operational logs, metrics, and alerts should identify integration failures, scoring failures, and traffic anomalies. | High |
| NFR-012 | Recoverability | Administrators should be able to recover from provider outages, incorrect results, and failed recalculation jobs. | High |

## 12.1 Performance Targets to Validate During Design

- Prediction save operation should complete within an agreed target
  under normal load, for example two seconds or less for the user-facing
  confirmation path.

- Leaderboard pages should use caching, snapshots, or efficient
  aggregation to avoid expensive recalculation on every page load.

- Bulk score recalculation should be designed as a controlled background
  or administrative process rather than a user-blocking operation.

- The system should degrade gracefully if external data synchronization
  is delayed; users should still see existing predictions and previous
  leaderboard state.

# 13. Administration, Operations, and Observability

## 13.1 Administrative Capabilities

| **Capability** | **Description** |
|----|----|
| Tournament configuration | Manage tournament start, lock window, scoring values, phases, and active status. |
| Allowed domains | Manage approved corporate domains or identity tenant rules through controlled configuration. |
| Match management | View imported matches, detect schedule changes, correct kickoff times, and approve results. |
| Participant management | View participants, disable participation if required, and support eligibility questions. |
| Manual result correction | Enter or correct official scores with reason, source, and audit record. |
| Final awards | Set or approve champion, runner-up, top scorer, and best player values for final scoring. |
| Recalculation | Trigger recalculation for one match, a set of matches, final predictions, or the full tournament. |
| Audit search | Search changes by participant, match, administrator, date range, or action type. |
| Operational dashboard | Monitor synchronization runs, error rates, pending corrections, and scoring job status. |

## 13.2 Operational Runbooks

Before launch, the team should prepare short operational runbooks for
common tournament incidents. These runbooks should be
technology-specific only after the implementation platform is selected.
At the architecture level, the required runbooks are:

- External provider unavailable or returning errors.

- Official score delayed beyond expected update window.

- Kickoff time changes after users have submitted predictions.

- A match is postponed, abandoned, or rescheduled.

- Incorrect score was used for scoring and must be corrected.

- Leaderboard appears inconsistent after recalculation.

- User reports being locked out despite having a Nortal email.

- User claims a prediction was saved but is not visible.

- Unexpected traffic spike before a match deadline.

## 13.3 Observability Requirements

| **Signal** | **Examples** | **Purpose** |
|----|----|----|
| Business metrics | Registered users, active users, predictions submitted, missing predictions, exact hits, leaderboard views. | Measure engagement and adoption. |
| Operational metrics | API latency, prediction save failures, integration run duration, recalculation duration, queue depth if applicable. | Detect performance or reliability issues. |
| Security metrics | Rejected external domains, failed authorization attempts, admin actions, unusual access patterns. | Support security review and incident response. |
| Data quality metrics | Unmatched teams, duplicate provider records, score corrections, kickoff time changes, stale matches. | Protect scoring accuracy. |
| User support metrics | Support requests by category, dispute count, resolved incidents. | Improve experience and communications. |

# 14. User Experience and Engagement Considerations

## 14.1 Participant Experience Requirements

- The dashboard should immediately show upcoming matches and whether
  each match is editable, locked, missing a prediction, or already
  predicted.

- The prediction form should be optimized for rapid score entry,
  especially on mobile devices.

- Each match should show an explicit lock countdown or lock date/time to
  reduce confusion.

- Locked predictions should remain visible but not editable.

- The application should explain scoring rules in simple language near
  the prediction experience and leaderboard.

- The personal score breakdown should show why each match produced 10,
  5, or 0 points.

- Final tournament predictions should have a separate prominent section
  with its own deadline and explanation.

- The leaderboard should be easy to scan and should show tie-breaker
  indicators if tie-breakers are used.

## 14.2 Engagement Enhancements

The following enhancements are not mandatory for MVP but can
significantly increase participation and perceived quality:

| **Enhancement** | **Value** | **Architecture consideration** |
|----|----|----|
| Prediction completeness meter | Encourages users to predict all upcoming matches. | Requires count of unlocked matches and participant submissions. |
| Deadline reminders | Reduces missed predictions before matches. | Requires notification preferences and scheduled reminders. |
| Badges | Adds lightweight gamification for exact hits, streaks, or participation. | Should be rule-driven and avoid excessive complexity. |
| Team/office leagues | Allows friendly competition by region, office, department, or team if approved. | Requires approved grouping data and privacy review. |
| Match cards | Improves visual appeal with flags, groups, stage, and kickoff time. | Requires reliable team metadata and responsive design. |
| Shareable internal highlights | Promotes engagement through internal channels. | Should avoid exposing personal data beyond approved visibility. |

## 14.3 Accessibility and Inclusiveness

- Use clear labels for team names and scores rather than relying only on
  flags or colors.

- Ensure contrast ratios are readable in ranking, lock status, and
  prediction forms.

- Support keyboard navigation for entering predictions.

- Avoid time-only communication without date and time zone context.

- Provide plain-language explanations for locks, scoring, and final
  prediction deadlines.

# 15. Quality Assurance and Acceptance Criteria

## 15.1 Core Test Scenarios

| **Area** | **Scenario** | **Expected result** |
|----|----|----|
| Access | User with approved Nortal domain can access the app. | Access granted and participant profile created or updated. |
| Access | User with non-approved domain attempts to access the app. | Access denied; no participant profile created; event logged. |
| Match prediction | User submits a prediction more than one hour before kickoff. | Prediction saved successfully. |
| Match prediction | User attempts to edit at exactly kickoff minus 60 minutes. | Edit rejected because the prediction is locked. |
| Match prediction | User attempts to edit 59 minutes before kickoff. | Edit rejected. |
| Match prediction | User edits 61 minutes before kickoff. | Edit accepted and audit history preserved. |
| Final predictions | User submits champion, runner-up, top scorer, and best player before first kickoff. | Final predictions saved successfully. |
| Final predictions | User attempts to edit after first kickoff. | Edit rejected. |
| Scoring | Predicted score equals official score. | 10 points awarded. |
| Scoring | Predicted winner/draw is correct but exact score differs. | 5 points awarded. |
| Scoring | Predicted outcome is incorrect. | 0 points awarded. |
| Recalculation | Official score is corrected after initial scoring. | Previous scoring is preserved in audit history and new scoring is calculated. |
| Integration | Provider API fails temporarily. | System retries according to policy and alerts administrators if failure persists. |
| Admin | Administrator manually corrects a score. | Correction requires reason/source and creates audit log. |

## 15.2 Acceptance Criteria

- All must-have functional requirements have test evidence.

- All lock-related rules are verified around boundary times, including
  exactly 60 minutes before kickoff.

- All scoring scenarios are verified using known examples.

- Access with non-approved domains is blocked through both UI and direct
  API attempts.

- Audit logs are produced for prediction changes, administrative
  corrections, and recalculations.

- Leaderboard results match independently calculated expected values for
  a representative data set.

- Manual fallback procedures are tested before the tournament starts.

- The selected implementation platform passes security and operational
  readiness review.

# 16. Delivery Roadmap

| **Phase** | **Focus** | **Exit outcome** |
|----|----|----|
| Phase 0 - Decisions and governance | Confirm domains, official rules, score basis, tie-breakers, privacy visibility, data provider strategy, and implementation approach. | Approved architecture decision records and product backlog baseline. |
| Phase 1 - Foundation | Build identity integration, participant profile, tournament configuration, match catalog, and prediction storage. | Eligible users can access and submit/edit predictions in a controlled test environment. |
| Phase 2 - Rules and scoring | Implement lock rules, final prediction lock, scoring engine, leaderboard, and audit trail. | Scoring and locks pass boundary tests. |
| Phase 3 - Data integration | Implement provider abstraction, schedule import, result synchronization, retries, and admin review workflow. | Fixtures and scores can be synchronized and corrected. |
| Phase 4 - UX polish and engagement | Improve dashboard, mobile experience, reminders, explanations, and leaderboard views. | Pilot users can participate with minimal guidance. |
| Phase 5 - Operational readiness | Prepare runbooks, monitoring, alerts, support model, load testing, and tournament rehearsal. | Go-live readiness approved. |
| Phase 6 - Tournament operations | Monitor matches, scores, leaderboards, support requests, and issue corrections as needed. | Stable tournament experience. |
| Phase 7 - Closure and retrospective | Finalize results, archive data, collect feedback, and document improvements for future tournaments. | Official winner published and lessons learned captured. |

## 16.1 Suggested MVP Definition

- Corporate-domain access only.

- Participant dashboard with upcoming matches.

- Match prediction creation and update with one-hour lock rule.

- Final tournament predictions with tournament-start lock rule.

- Manual or semi-automated match result entry if integration is not
  production-ready yet.

- Scoring engine for match and final predictions.

- Leaderboard and personal breakdown.

- Basic administration for match data, results, recalculation, and audit
  review.

## 16.2 Post-MVP Enhancements

- Automated provider synchronization with multiple provider fallback.

- Notification reminders for missing predictions.

- Office/team leagues if approved by privacy and data governance.

- Badges and achievement system.

- Advanced analytics dashboard for engagement and tournament insights.

- Multi-language UI.

- Reusable tournament template for future competitions.

# 17. Risks, Mitigations, and Open Decisions

## 17.1 Risk Register

| **ID** | **Risk** | **Description** | **Mitigation** | **Level** |
|----|----|----|----|----|
| R-001 | External data provider limitations | Free provider may have delayed scores, coverage gaps, or rate limits. | Use provider abstraction, caching, manual fallback, and pre-launch provider validation. | High |
| R-002 | Ambiguous scoring rules | Knockout matches, extra time, penalties, and top scorer ties may create disputes. | Approve detailed scoring policy before development completion. | High |
| R-003 | Late schedule changes | Kickoff time changes may affect lock windows and user trust. | Track schedule versions, alert admins, and communicate changes clearly. | Medium |
| R-004 | Unauthorized access | External users could attempt to sign in or call APIs directly. | Enforce domain/tenant eligibility at identity, application, and API layers. | High |
| R-005 | Traffic spikes | Users may submit predictions shortly before lock deadlines. | Optimize write path, scale critical components, and test peak loads. | Medium |
| R-006 | Leaderboard disputes | Users may question points or ranking tie-breakers. | Show transparent breakdowns and retain audit evidence. | Medium |
| R-007 | Over-customization | Too many engagement features may delay MVP. | Deliver core prediction and scoring first; defer enhancements. | Medium |
| R-008 | Single technology lock-in too early | Prematurely choosing a platform may limit scalability or maintainability. | Evaluate implementation options separately using objective criteria. | Medium |

## 17.2 Open Decisions

| **ID** | **Decision** | **Question** | **Owner** |
|----|----|----|----|
| OD-001 | Approved email domains | What exact Nortal domains or identity tenants are eligible? | Security / business sponsor |
| OD-002 | Official score basis | For knockout matches, should predictions be evaluated on regular time, extra time included, or another official score basis? | Business sponsor / rules owner |
| OD-003 | Penalty shootouts | Are penalty shootout scores excluded from score prediction? | Business sponsor / rules owner |
| OD-004 | Top scorer ties | If multiple players share top scorer status, should all be accepted? | Business sponsor / rules owner |
| OD-005 | Best player source | Which official source determines the best player? | Business sponsor / admin owner |
| OD-006 | Leaderboard visibility | Can all participants see all names, or should visibility be limited? | Privacy / business sponsor |
| OD-007 | Implementation approach | Which technology stack or platform will be selected after evaluating options? | Architecture board / engineering |
| OD-008 | Notification channels | Which internal channels are approved for reminders and announcements? | Business sponsor / communications |

# 18. Glossary and References

## 18.1 Glossary

| **Term** | **Definition** |
|----|----|
| Approved domain | An email domain or identity tenant formally allowed to access the application. |
| Canonical time | The normalized time standard used by the system to calculate deadlines, typically UTC. |
| Exact score | A prediction where both team scores exactly match the official score. |
| Correct outcome | A prediction where the user correctly predicts the winner or draw, but not the exact score. |
| Final predictions | Predictions for champion, runner-up, top scorer, and best player. |
| Lock window | The period before a match when predictions can no longer be created or edited. The baseline is one hour before kickoff. |
| Provider abstraction | A design pattern where the application consumes normalized internal data instead of directly depending on one external provider schema. |
| Recalculation | The process of recalculating points after official results or rules inputs change. |

## 18.2 References

- FIFA World Cup 2026 official match schedule and fixtures:
  [<u>https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums</u>](https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums)

- football-data.org API Quickstart and v4 documentation:
  [<u>https://www.football-data.org/documentation/quickstart</u>](https://www.football-data.org/documentation/quickstart)

- football-data.org API Reference - Competition and Match resources:
  [<u>https://www.football-data.org/documentation/api</u>](https://www.football-data.org/documentation/api)

- football-data.org v4 Competition Resource documentation:
  [<u>https://docs.football-data.org/general/v4/competition.html</u>](https://docs.football-data.org/general/v4/competition.html)

- football-data.org v4 Match Resource documentation:
  [<u>https://docs.football-data.org/general/v4/match.html</u>](https://docs.football-data.org/general/v4/match.html)

- football-data.org Pricing:
  [<u>https://www.football-data.org/pricing</u>](https://www.football-data.org/pricing)

- football-data.org Coverage:
  [<u>https://www.football-data.org/coverage</u>](https://www.football-data.org/coverage)

# Appendix A - Requirements Traceability Matrix

| **Business need** | **Mapped requirements/sections** | **Architectural support** |
|----|----|----|
| Access restricted to Nortal domain | FR-001, FR-002, Security 11.1, Domain Model 11.2 | Identity boundary, application/API authorization, audit log |
| Users can create multiple match predictions | FR-005, FR-006 | Prediction management, match catalog |
| Users can edit match predictions if more than one hour remains | FR-007, FR-008, BR-LOCK-002 | Business rules layer, canonical time |
| Users cannot edit within one hour of kickoff | FR-008, BR-LOCK-003 | Server-side lock validation |
| Final predictions before first match only | FR-009, FR-010, BR-LOCK-005 | Final prediction module, tournament configuration |
| Exact score = 10 points | FR-011, Scoring 7.2 | Scoring engine |
| Correct winner/draw = 5 points | FR-011, Scoring 7.2 | Scoring engine |
| Incorrect prediction = 0 points | FR-011, Scoring 7.2 | Scoring engine |
| Final prediction item = 20 points | FR-012, Scoring 7.3 | Scoring engine, final awards data |
| Automated match data updates | FR-017, Integration 10 | Integration layer, provider abstraction |
| Detailed auditability | FR-018, Security 11.1, Data Architecture 9 | Audit log, score events, integration runs |
| Technology-agnostic architecture | Architecture Principles 3, Patterns 8.3 | Capability-based design and architecture decision process |

# Appendix B - Implementation Option Evaluation Scorecard

The following scorecard can be used later to compare implementation
options without embedding a technology decision into this high-level
architecture.

| **Criterion** | **Evaluation question** | **Weight** |
|----|----|----|
| Security and identity fit | Can it enforce corporate SSO, domain eligibility, role-based access, and audit requirements? | High |
| Delivery speed | Can MVP be delivered and tested before tournament readiness deadlines? | High |
| Rules complexity | Can it centralize and test lock, scoring, and recalculation logic reliably? | High |
| User experience | Can it deliver a polished, responsive, engaging experience for participants? | Medium |
| Integration flexibility | Can it abstract and replace external football data providers? | High |
| Operational support | Can it provide monitoring, alerts, logs, and recovery procedures? | High |
| Cost and licensing | Are licensing and hosting costs appropriate for expected participant volume? | Medium |
| Maintainability | Can the solution be maintained by Nortal after the tournament and reused later? | Medium |
| Vendor/platform lock-in | Can data, rules, and integrations be migrated or reused if needed? | Medium |
| Governance acceptance | Does the approach comply with corporate standards, privacy, and security review? | High |

# Appendix C - Pre-Launch Checklist

- Approved domains and identity rules configured and tested.

- All tournament matches imported and verified against official
  schedule.

- First-match tournament lock timestamp approved.

- Knockout scoring basis approved and communicated.

- Penalty shootout rule approved and communicated.

- Top scorer tie policy approved and communicated.

- Best player official source approved.

- External data provider tested under expected rate limits.

- Manual result correction runbook tested.

- Score recalculation tested with sample correction scenario.

- Leaderboard tie-breakers tested.

- Audit log search tested.

- User support process and communication templates prepared.

- Monitoring and alerting enabled for integration and scoring failures.

- Privacy notice reviewed and published if required.

- Pilot test completed with representative users.

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr>
<th><p><strong>Final architectural recommendation</strong></p>
<p>Approve the business rules and decision items before selecting the
implementation technology. Once the rules, data ownership, identity
model, and integration strategy are stable, the team can choose the best
implementation approach without redesigning the product.</p></th>
</tr>
</thead>
<tbody>
</tbody>
</table>
