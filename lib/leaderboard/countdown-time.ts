/**
 * Pure helpers for the pre-tournament countdown body of
 * `<EmptyLeaderboardState/>` (feature 004 US-LE T035 / FR-L07).
 *
 * Two responsibilities, split into two helpers so each is independently
 * testable:
 *
 *   1. `formatCountdownTarget` — render the first-kickoff timestamp as a
 *      locale-aware absolute time string in the participant's IANA
 *      timezone. Example: "June 12, 2026 at 6:00 PM GMT-3" (en),
 *      "12 de junio de 2026, 18:00 GMT-3" (es).
 *
 *   2. `formatRelativeCountdown` — render a relative "in 5 days" /
 *      "in 3 hours" / "in 2 minutes" phrase via `Intl.RelativeTimeFormat`.
 *      Picks the largest unit (days → hours → minutes) where magnitude
 *      ≥ 1, falling back to "now" for ≤ 60 seconds remaining or any
 *      non-positive delta. Avoiding `Intl.RelativeTimeFormat(..., 'second')`
 *      around the boundary keeps the rendered string stable as the clock
 *      ticks through kickoff.
 *
 * Both helpers are total — they never throw on valid `Date`/locale inputs.
 * Locale fallback is delegated to the `Intl.*` constructors themselves
 * (an unknown locale resolves to the runtime default rather than erroring).
 */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * 60;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;

export function formatCountdownTarget(
  firstKickoffUtc: Date,
  userTz: string,
  locale: string,
): string {
  // NOTE: ECMA-402 disallows combining `dateStyle`/`timeStyle` shorthand
  // with explicit field options like `timeZoneName`. We need the GMT-3 /
  // BRT suffix so the rendered string is unambiguous for participants
  // outside their displayed timezone, so we opt for the explicit-field
  // form below. The output matches the long+short pairing in shape:
  //   en   → "June 12, 2026 at 6:00 PM GMT-3"
  //   es   → "12 de junio de 2026, 18:00 GMT-3"
  //   pt-BR → "12 de junho de 2026 às 18:00 BRT"
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: userTz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return formatter.format(firstKickoffUtc);
}

export function formatRelativeCountdown(
  firstKickoffUtc: Date,
  now: Date,
  locale: string,
): string {
  const deltaSeconds = Math.round((firstKickoffUtc.getTime() - now.getTime()) / 1000);

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  // At or past kickoff (or within the last minute before it) — render
  // "now" via the auto-numeric mode of RelativeTimeFormat. Falling through
  // to the unit picker would otherwise produce a churny "in 0 seconds" or
  // similar string. Using `0` with `numeric: 'auto'` produces "now" in en
  // ("ahora" / "agora") and stable equivalents across locales.
  if (deltaSeconds <= SECONDS_PER_MINUTE) {
    return relative.format(0, 'second');
  }

  if (Math.abs(deltaSeconds) >= SECONDS_PER_DAY) {
    return relative.format(Math.round(deltaSeconds / SECONDS_PER_DAY), 'day');
  }
  if (Math.abs(deltaSeconds) >= SECONDS_PER_HOUR) {
    return relative.format(Math.round(deltaSeconds / SECONDS_PER_HOUR), 'hour');
  }
  return relative.format(Math.round(deltaSeconds / SECONDS_PER_MINUTE), 'minute');
}
