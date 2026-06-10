import { getTranslations } from 'next-intl/server';

/**
 * `<PreTournamentPlaceholder/>` — pre-tournament Pool-tab widget
 * replacement (feature 005 US-DE T040 / FR-D14).
 *
 * Server Component. Renders the same visual idiom as feature 004's
 * `<EmptyLeaderboardState/>` (centred rounded card, gray-50 background,
 * polite live region) but with a widget-specific body line so
 * participants who land on the Pool tab before the first kickoff still
 * understand WHICH dashboard surface they're looking at.
 *
 * The composer (`<DashboardPage/>`) swaps these in for the three Pool
 * widgets (Movers / Digest / Neighborhood) when `is_pre_tournament()`
 * returns true. The three Today widgets render unchanged — their own
 * pre-tournament empty states (RankWidget countdown, UpcomingMatches
 * upcoming-first-match card, SnapshotWidget "next" card) kick in
 * independently per FR-D14.
 *
 * The `aria-labelledby` matches each replaced widget's section id
 * (`neighborhood-heading` / `movers-heading` / `digest-heading`) so any
 * downstream screen-reader bookmarks (or test locators) survive the
 * swap.
 */

type PreTournamentPlaceholderProps = {
  widgetType: 'movers' | 'digest' | 'neighborhood';
  // `locale` is part of the prop contract for future locale-aware body
  // formatting; not consumed directly yet but mirrors the sibling Pool
  // widgets so the composer wires identical props.
  locale: string;
};

const HEADING_ID_BY_TYPE: Record<PreTournamentPlaceholderProps['widgetType'], string> = {
  movers: 'movers-heading',
  digest: 'digest-heading',
  neighborhood: 'neighborhood-heading',
};

const BODY_KEY_BY_TYPE: Record<PreTournamentPlaceholderProps['widgetType'], string> = {
  movers: 'preTournamentMoversBody',
  digest: 'preTournamentDigestBody',
  neighborhood: 'preTournamentNeighborhoodBody',
};

export default async function PreTournamentPlaceholder({
  widgetType,
  locale: _locale,
}: PreTournamentPlaceholderProps): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');

  const headingId = HEADING_ID_BY_TYPE[widgetType];
  const bodyKey = BODY_KEY_BY_TYPE[widgetType];

  return (
    <section
      className="mt-4 mx-auto max-w-md rounded-md border border-gray-200 bg-gray-50 p-6 text-center"
      aria-labelledby={headingId}
      aria-live="polite"
    >
      <h2 id={headingId} className="text-base font-semibold text-gray-900">
        {t('preTournamentHeading')}
      </h2>
      <p className="mt-2 text-sm text-gray-600">{t(bodyKey)}</p>
    </section>
  );
}
