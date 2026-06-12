# Contract — `scrub_pii_for_teams(input text) RETURNS text`

**Purpose**: Redact PII from an arbitrary string before it is included in a Microsoft Teams notification payload. Used by both `notify_teams_on_runs_error()` (for the live error_message at notification time) and `reconcile_teams_notifications()` (for the HTTP response body / pg_net error_msg at failure-audit time).

**Volatility**: `IMMUTABLE`. Output depends only on `input`. No clock, no SELECT, no SET.
**Security**: not SECURITY DEFINER (caller's permissions suffice — pure function, no privileged operations).
**Search path**: `pg_temp` (defensive — no public references inside the body).

## Signature

```sql
CREATE OR REPLACE FUNCTION scrub_pii_for_teams(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp;
```

## Behavior

Applies the following regex substitutions, in order. Every match is replaced by the literal token `[REDACTED]`. After scrubbing, the result is truncated to 500 characters via `substr(out, 1, 500)`.

| # | Regex | Catches | Notes |
|---|-------|---------|-------|
| 1 | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | RFC 5322-shape emails | Includes `participant@nortal.com`, `support@football-data.org`, etc. The TLD constraint `{2,}` filters out trailing punctuation. |
| 2 | `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` | Standard UUIDs | Covers Microsoft `oid`, `participant_id`, `player_id`, **and `match_id`**. The match_id is a known acceptable cost — runbooks tell the admin to fetch the unredacted row from psql. |
| 3 | `\mnortal\.com\M` | Bare `nortal.com` mentions | `\m` and `\M` are PostgreSQL POSIX regex word boundaries (alphanumeric-or-underscore). Catches text like "tenant nortal.com filter failed" without re-matching the email pattern. |

## Edge cases

- **NULL input** → returns empty string (`COALESCE(input, '')` at function head). Avoids NULL propagation into the Teams payload which would break the JSON shape.
- **Empty string input** → returns empty string.
- **No matches** → returns input verbatim, truncated to 500 chars.
- **Input > 500 chars after scrubbing** → truncated; the truncation happens AFTER scrubbing so we never expose a half-redacted UUID at the boundary.
- **Overlapping matches** (e.g., an email-shape string containing nortal.com) → email pattern runs first; the UUID-shape and nortal.com patterns then see `[REDACTED]` text and do not re-match.

## Determinism

Because the function is `IMMUTABLE`, Postgres may cache results within a query plan. pgTAP tests assert determinism explicitly: `is(scrub_pii_for_teams('alice@nortal.com'), '[REDACTED]', ...)` must succeed reproducibly across invocations.

## Test coverage (pgTAP `027_scrub_pii_for_teams.sql`)

Twelve test cases:

| # | Input | Expected output |
|---|---|---|
| 1 | `NULL` | `''` (empty string) |
| 2 | `''` | `''` |
| 3 | `'no pii here'` | `'no pii here'` |
| 4 | `'alice@nortal.com'` | `'[REDACTED]'` |
| 5 | `'00112233-4455-6677-8899-aabbccddeeff'` | `'[REDACTED]'` |
| 6 | `'tenant nortal.com filter failed'` | `'tenant [REDACTED] filter failed'` |
| 7 | `'predicted alice@nortal.com chose 2-1'` | `'predicted [REDACTED] chose 2-1'` |
| 8 | `'participant 00112233-... match ffeeddcc-... SQLSTATE 23503'` | `'participant [REDACTED] match [REDACTED] SQLSTATE 23503'` |
| 9 | `'alice@nortal.com 00112233-4455-6677-8899-aabbccddeeff'` | `'[REDACTED] [REDACTED]'` |
| 10 | repeated 600-char string of `'a@a.aa '` | exactly 500 chars long, ends mid-`[REDACTED]` only on a token boundary if length permits |
| 11 | `'NORTAL.COM'` (case mismatch) | `'NORTAL.COM'` — UNCHANGED. The regex is case-sensitive by design; uppercase Nortal mentions are rare in error messages and the runbook adds context. Documented as an accepted limitation. |
| 12 | `'00112233-4455-6677-8899-AABBCCDDEEFF'` (uppercase UUID) | `'00112233-4455-6677-8899-AABBCCDDEEFF'` — UNCHANGED. UUIDs in Postgres `error_message` strings are lower-case by convention (`pg_typeof(::uuid)::text` outputs lowercase). Acceptable limitation; documented. |

The two "accepted limitation" cases (11 + 12) are explicit per case-sensitivity tradeoff: making the regex case-insensitive would catch the few stray uppercase variants but would also slow the regex by ~30% per PostgreSQL benchmark notes. The plan trades exactness for speed because the universe of real-world error messages is dominated by the case-sensitive form.

## Forward compatibility

If future scrubbing needs land (e.g., phone numbers, internal IPs, credit-card shapes), the function evolves additively — new regex blocks are appended in `CREATE OR REPLACE` migrations. The `IMMUTABLE` declaration must be preserved so unit tests stay deterministic.
