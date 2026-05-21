/**
 * Day-bucket helper for the `/matches` catalog browse view.
 *
 * Implements FR-M17: matches on `/matches` MUST be grouped by *participant-
 * local* day (not UTC date), and each group MUST carry a localised header.
 * The three days adjacent to "today" in the participant's timezone surface as
 * direct labels — "Today" / "Tomorrow" / "Yesterday" (and their es / pt-BR
 * equivalents). Other days surface as an explicit localised weekday + month +
 * day (e.g. "Saturday, June 13" in en; "sábado, 13 de junio" in es).
 *
 * Cross-TZ contract (TC-M9):
 *   The same `kickoffUtc` must produce *different* bucket keys for two
 *   participants in different timezones when their local calendar dates
 *   differ. E.g. a kickoff at `2026-06-13T23:00:00Z` viewed from
 *   `Europe/Tallinn` (UTC+3 summer) falls on `2026-06-14`, while the same
 *   kickoff viewed from `America/Sao_Paulo` (UTC-3) falls on `2026-06-13`.
 *   The grouping key is therefore computed *in the participant's TZ*, not
 *   in UTC, so participants see "their" day boundaries.
 *
 * Why `Intl.DateTimeFormat` instead of `Intl.RelativeTimeFormat`:
 *   Per research.md §R-6, RelativeTimeFormat produces strings like
 *   "in 1 day" / "Em 1 dia" / "Hace 1 día" — grammatically correct but
 *   awkward as *section headers*. Calendar UX consistently uses direct
 *   labels ("Today" / "Hoy" / "Hoje") for the adjacent-day case, and we
 *   want that register here. For non-adjacent days, `Intl.DateTimeFormat`
 *   with `timeZone` set gives us a fully-localised weekday + month + day
 *   without hand-maintaining locale tables.
 *
 * DST safety:
 *   `Intl.DateTimeFormat` with `timeZone` set handles DST transitions
 *   internally — a kickoff during a spring-forward / fall-back boundary
 *   still resolves to the correct local calendar date without manual
 *   offset arithmetic. We never compute offsets from raw `Date` epochs
 *   ourselves; everything flows through `formatToParts` against the
 *   participant TZ.
 *
 * Pure function: no I/O, no React, no Next.js, no console output. Caller
 * supplies `nowUtc` (so tests are deterministic and SSR is consistent) and
 * decides what to do on the invalid-TZ fallback path — this module is
 * silent.
 */

export type Locale = 'en' | 'es' | 'pt-BR';

export type DayBucket = {
  /** ISO date (`YYYY-MM-DD`) in the participant's timezone — grouping key. */
  bucketKey: string;
  /** Localised display label for the day-bucket header. */
  bucketLabel: string;
  /** Calendar-day delta from `now` in the participant TZ. `0` = today. */
  offsetFromToday: number;
};

/**
 * Localised "Today" / "Tomorrow" / "Yesterday" labels keyed by offset.
 *
 * Mirrors the i18n namespace keys (`matches.today` / `matches.tomorrow` /
 * `matches.yesterday`) called out in research.md §R-6. Kept inline here so
 * the helper stays pure and free of next-intl imports — the caller passes
 * the locale string, not a translator instance.
 */
const ADJACENT_DAY_LABELS: Record<Locale, Record<-1 | 0 | 1, string>> = {
  en: { [-1]: 'Yesterday', [0]: 'Today', [1]: 'Tomorrow' },
  es: { [-1]: 'Ayer', [0]: 'Hoy', [1]: 'Mañana' },
  'pt-BR': { [-1]: 'Ontem', [0]: 'Hoje', [1]: 'Amanhã' },
};

/**
 * Compute the localised day-bucket information for a single match card.
 *
 * @param kickoffUtc    Match kickoff timestamp in UTC.
 * @param participantTz IANA timezone of the viewing participant
 *                      (e.g. `Europe/Tallinn`, `America/Sao_Paulo`).
 *                      Invalid zones silently fall back to `UTC`.
 * @param locale        UI locale; one of `'en' | 'es' | 'pt-BR'`.
 * @param nowUtc        "Current" UTC time — supplied by caller so SSR and
 *                      tests are deterministic.
 */
export function dayBucket(
  kickoffUtc: Date,
  participantTz: string,
  locale: Locale,
  nowUtc: Date,
): DayBucket {
  // Resolve the effective TZ once: if `participantTz` is not a valid IANA
  // zone, every subsequent `Intl.DateTimeFormat` call would throw. We swap
  // to UTC silently — the renderer-side fallback policy from spec.md §3
  // (logging is the caller's concern, not this pure helper's).
  const effectiveTz = isValidTimeZone(participantTz) ? participantTz : 'UTC';

  // Extract local calendar components for both timestamps in the *same* TZ.
  // We use `formatToParts` + the `year` / `month` / `day` parts rather than
  // string parsing so the result is locale-independent (the parts are
  // always numeric strings regardless of `locale`).
  const kickoffParts = getDateParts(kickoffUtc, effectiveTz);
  const nowParts = getDateParts(nowUtc, effectiveTz);

  const bucketKey = formatBucketKey(kickoffParts);

  // Day-offset arithmetic happens on UTC midnights synthesised from the
  // *local* date parts. This is the standard trick for "days between two
  // calendar dates in a given TZ": once both timestamps are reduced to
  // their YMD triples in the same TZ, the UTC epoch of midnight on those
  // dates differs by exactly N * 86_400_000 ms — no DST double-counting
  // because we never look at the time component on either side.
  const kickoffMidnightUtc = Date.UTC(
    kickoffParts.year,
    kickoffParts.month - 1,
    kickoffParts.day,
  );
  const nowMidnightUtc = Date.UTC(
    nowParts.year,
    nowParts.month - 1,
    nowParts.day,
  );
  const MS_PER_DAY = 86_400_000;
  const offsetFromToday = Math.round(
    (kickoffMidnightUtc - nowMidnightUtc) / MS_PER_DAY,
  );

  const bucketLabel = formatBucketLabel(
    kickoffUtc,
    effectiveTz,
    locale,
    offsetFromToday,
  );

  return { bucketKey, bucketLabel, offsetFromToday };
}

// --- internals --------------------------------------------------------------

type DateParts = { year: number; month: number; day: number };

/**
 * Extract `{year, month, day}` for a UTC instant *as it falls* in `timeZone`.
 *
 * Uses `formatToParts` with explicit numeric parts so the output is
 * independent of the formatter's locale. `month` is 1-based (Jan = 1) to
 * match the calendar convention; convert to JS's 0-based month on use.
 */
function getDateParts(instant: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    else if (part.type === 'month') month = Number.parseInt(part.value, 10);
    else if (part.type === 'day') day = Number.parseInt(part.value, 10);
  }
  return { year, month, day };
}

/** Format the grouping key as ISO `YYYY-MM-DD` from local date parts. */
function formatBucketKey({ year, month, day }: DateParts): string {
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

/**
 * Build the human-facing header label.
 *
 * For the three adjacent days we use the direct lookup table (per research
 * §R-6 — RelativeTimeFormat reads awkwardly as a header). For any other
 * offset we format via `Intl.DateTimeFormat` with `timeZone` set so the
 * weekday and month names reflect *participant local time*, not the
 * server's TZ.
 */
function formatBucketLabel(
  kickoffUtc: Date,
  timeZone: string,
  locale: Locale,
  offsetFromToday: number,
): string {
  if (offsetFromToday === -1 || offsetFromToday === 0 || offsetFromToday === 1) {
    return ADJACENT_DAY_LABELS[locale][offsetFromToday];
  }

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(kickoffUtc);
}

/**
 * Probe-format with the given TZ; treat any `RangeError` from the ICU
 * tables as "unsupported / invalid zone". This is the standard cross-
 * runtime test — feature detection over allow-list maintenance.
 */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
