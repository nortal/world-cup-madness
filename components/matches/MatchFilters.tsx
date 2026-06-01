import { getTranslations } from 'next-intl/server';

/**
 * Match list filter chips (US-M / T030 — FR-M05).
 *
 * Server Component — renders three `<select>` dropdowns (stage, group, team)
 * inside a `<form method="get" action="/matches">`. Selections compose with
 * AND semantics by riding on the URL as query params
 * (`/matches?stage=round-of-16&group=A&team=BRA`), so filtered views are
 * naturally shareable links and back-button friendly.
 *
 * Why a GET form instead of a Client Component with `onChange`:
 *   - The Frontend Constitution mandates Server Components by default and
 *     reserves `'use client'` for genuine interactive state.
 *   - This feature is pure navigation — the browser already knows how to
 *     submit a GET form and update the URL. Adding `'use client'` +
 *     `useState` + `useRouter` would reimplement what the browser provides
 *     for free, ship more JS, and offer no UX benefit.
 *   - The page (Server Component) reads `searchParams`, queries the database
 *     filtered, and re-renders. Lock status and authoritative match data
 *     still come from the server — no client-side calculation drift.
 *
 * Accessibility notes:
 *   - Native `<select>` is the most screen-reader-friendly multi-option
 *     control across desktop and mobile (NVDA, JAWS, VoiceOver, TalkBack
 *     announce option count and current selection without any ARIA work).
 *   - Each `<select>` carries an `aria-label` matching its "All X" first
 *     option, so screen readers announce the field purpose (e.g. "All stages,
 *     combo box"). We deliberately omit visible `<label>` elements to keep
 *     the row compact; the first option doubles as a visible placeholder.
 *   - All controls are focusable in tab order; the form submits on Enter.
 *
 * Translation keys consumed:
 *   - `matches.filters.{allStages, allGroups, allTeams, clearFilters}`
 *   - `matches.stages.*` (stage labels)
 *   - `matches.groupLabel` (with `{letter}` interpolation)
 *
 * Clear-filters behaviour:
 *   - Implemented as an anchor link styled like a button that navigates to
 *     `/matches` with no query string. This is the simplest HTML-native way
 *     to drop all selections without `'use client'`. A `<button type=submit
 *     formaction="/matches">` inside the same form would still serialize the
 *     `<select>` values into the URL, defeating the "clear" intent. The
 *     anchor sidesteps the form entirely and produces a clean `/matches` URL.
 *
 * Apply behaviour:
 *   - A single submit button submits the form. The selects do not auto-submit
 *     on change (that would require `'use client'` + onChange + useRouter,
 *     which the constitution forbids for pure-navigation UI).
 */

type Stage =
  | 'group'
  | 'round-of-16'
  | 'quarter-final'
  | 'semi-final'
  | 'third-place'
  | 'final';

type MatchFiltersProps = {
  searchParams: {
    stage?: string;
    group?: string;
    team?: string;
  };
  availableStages: Stage[];
  availableGroups: string[];
  availableTeams: Array<{ tla: string; name: string }>;
};

export default async function MatchFilters({
  searchParams,
  availableStages,
  availableGroups,
  availableTeams,
}: MatchFiltersProps) {
  const tFilters = await getTranslations('matches.filters');
  const tStages = await getTranslations('matches.stages');
  const tMatches = await getTranslations('matches');

  return (
    <form
      method="get"
      action="/matches"
      className="flex flex-wrap items-end gap-3 rounded-md border border-gray-200 bg-white p-3"
    >
      <select
        name="stage"
        aria-label={tFilters('allStages')}
        defaultValue={searchParams.stage ?? ''}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{tFilters('allStages')}</option>
        {availableStages.map((stage) => (
          <option key={stage} value={stage}>
            {tStages(stage)}
          </option>
        ))}
      </select>

      <select
        name="group"
        aria-label={tFilters('allGroups')}
        defaultValue={searchParams.group ?? ''}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{tFilters('allGroups')}</option>
        {availableGroups.map((letter) => (
          <option key={letter} value={letter}>
            {tMatches('groupLabel', { letter })}
          </option>
        ))}
      </select>

      <select
        name="team"
        aria-label={tFilters('allTeams')}
        defaultValue={searchParams.team ?? ''}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">{tFilters('allTeams')}</option>
        {availableTeams.map((team) => (
          <option key={team.tla} value={team.tla}>
            {`${team.name} (${team.tla})`}
          </option>
        ))}
      </select>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          {tFilters('apply')}
        </button>
        <a
          href="/matches"
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          {tFilters('clearFilters')}
        </a>
      </div>
    </form>
  );
}
