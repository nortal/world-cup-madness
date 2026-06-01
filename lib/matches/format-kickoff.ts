/**
 * Kickoff-time formatter for the match catalog (FR-M07, NFR-M4).
 *
 * Pure function that renders a UTC kickoff `Date` in the participant's
 * resolved timezone and locale. The render is the only place a TZ shift
 * happens — kickoffs are always stored as UTC `timestamptz` in Postgres
 * (NFR-M4: "store UTC, shift at render"), so this helper is the single
 * authority for "what does the user see in their row of the table?".
 *
 * Locale conventions (FR-M07):
 *   - `en`    — 12-hour clock with AM/PM (e.g. "Saturday, June 13, 2026 at 6:00 PM").
 *   - `es`    — 24-hour clock, Spanish month name (e.g. "sábado, 13 de junio de 2026, 18:00").
 *   - `pt-BR` — 24-hour clock, Portuguese month name (e.g. "sábado, 13 de junho de 2026, 18:00").
 *
 * Implementation: we defer entirely to `Intl.DateTimeFormat` with
 * `dateStyle: 'full' + timeStyle: 'short'`. That combination gives us the
 * locale-correct ordering, separators, weekday spelling, and (critically)
 * the locale's idiomatic clock — `en` uses 12-hour by default, `es`/`pt-BR`
 * use 24-hour by default — without us hard-coding `hour12` per locale. The
 * `timeZone` option then shifts the displayed wall-clock time into the
 * participant's IANA zone; DST is handled inside the platform's ICU data,
 * so this function does not need any DST logic of its own.
 *
 * Invalid-TZ fallback policy (spec.md §3): if `participantTz` is not a
 * valid IANA identifier, we silently fall back to UTC. The function never
 * throws — the caller (a Server Component) is the wrong place to surface a
 * TZ-validation error, and the renderer fallback policy is "show
 * something" rather than "crash the page". A separate code path (the
 * profile `update-timezone` RPC, T026) is responsible for rejecting bad TZ
 * values at write time, so reaching the fallback here implies stale data,
 * which is rare and benign for read-only display.
 *
 * NULL kickoff: `scheduled-tbd` matches have NULL kickoff per the DB
 * CHECK in supabase/migrations/0012_create_matches.sql. For those rows
 * the renderer wants an empty cell (the badge column will say "TBD"), so
 * we return an empty string rather than "Invalid Date" or a placeholder.
 *
 * Pure function: no I/O, no console output, no React, no Next.js. The
 * `Locale` type is intentionally re-declared locally (rather than imported
 * from `lib/i18n/locales`) to keep this helper free of `next-intl` /
 * `next/headers` transitive coupling and to mirror the self-contained
 * shape of `lock-badge.ts`.
 */

/** Supported locales — must match `lib/i18n/locales.ts` (ADR-008). */
export type Locale = 'en' | 'es' | 'pt-BR';

export function formatKickoff(
  kickoffUtc: Date | null,
  participantTz: string,
  locale: Locale,
): string {
  // NULL kickoff → caller renders an empty cell. See module docblock.
  if (kickoffUtc === null) return '';

  // `dateStyle: 'full' + timeStyle: 'short'` gives the locale-idiomatic
  // weekday + long date + short time without us specifying every field.
  // `hour12` is intentionally omitted: ICU picks the locale's default
  // clock (12h for en, 24h for es/pt-BR), which matches FR-M07 exactly.
  const baseOptions: Intl.DateTimeFormatOptions = {
    dateStyle: 'full',
    timeStyle: 'short',
  };

  // First attempt: use the supplied timezone. If `Intl.DateTimeFormat`
  // rejects it (RangeError on unknown IANA id), silently fall back to
  // UTC. We do NOT log here — the caller (Server Component) decides
  // whether stale TZ data is worth surfacing.
  try {
    return new Intl.DateTimeFormat(locale, {
      ...baseOptions,
      timeZone: participantTz,
    }).format(kickoffUtc);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      ...baseOptions,
      timeZone: 'UTC',
    }).format(kickoffUtc);
  }
}
