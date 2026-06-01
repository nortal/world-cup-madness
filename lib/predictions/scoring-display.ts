/**
 * Scoring-display helpers for the breakdown page (feature 003 US-PD / FR-P27).
 *
 * Pure functions: map a score_event source enum to a human label, and sum
 * points across a set of score events. No I/O — the breakdown page fetches
 * the rows and passes them in.
 */

export type ScoreEventSource =
  | 'match-exact'
  | 'match-outcome'
  | 'match-wrong'
  | 'no-prediction'
  | 'match-cancelled'
  | 'final-champion'
  | 'final-runner-up'
  | 'final-top-scorer'
  | 'final-best-player'
  | 'final-not-picked-champion'
  | 'final-not-picked-runner-up'
  | 'final-not-picked-top-scorer'
  | 'final-not-picked-best-player';

export type BreakdownLocale = 'en' | 'es' | 'pt-BR';

type LabelKey =
  | 'exact' | 'outcome' | 'wrong' | 'noPrediction' | 'cancelled'
  | 'champion' | 'runnerUp' | 'topScorer' | 'bestPlayer'
  | 'notPickedChampion' | 'notPickedRunnerUp' | 'notPickedTopScorer' | 'notPickedBestPlayer';

const SOURCE_TO_KEY: Record<ScoreEventSource, LabelKey> = {
  'match-exact': 'exact',
  'match-outcome': 'outcome',
  'match-wrong': 'wrong',
  'no-prediction': 'noPrediction',
  'match-cancelled': 'cancelled',
  'final-champion': 'champion',
  'final-runner-up': 'runnerUp',
  'final-top-scorer': 'topScorer',
  'final-best-player': 'bestPlayer',
  'final-not-picked-champion': 'notPickedChampion',
  'final-not-picked-runner-up': 'notPickedRunnerUp',
  'final-not-picked-top-scorer': 'notPickedTopScorer',
  'final-not-picked-best-player': 'notPickedBestPlayer',
};

const LABELS: Record<BreakdownLocale, Record<LabelKey, string>> = {
  en: {
    exact: 'Exact score', outcome: 'Correct outcome', wrong: 'Wrong outcome',
    noPrediction: 'No prediction', cancelled: 'Match cancelled',
    champion: 'Champion', runnerUp: 'Runner-up', topScorer: 'Top scorer', bestPlayer: 'Best player',
    notPickedChampion: 'Champion (not picked)', notPickedRunnerUp: 'Runner-up (not picked)',
    notPickedTopScorer: 'Top scorer (not picked)', notPickedBestPlayer: 'Best player (not picked)',
  },
  es: {
    exact: 'Marcador exacto', outcome: 'Resultado correcto', wrong: 'Resultado incorrecto',
    noPrediction: 'Sin pronóstico', cancelled: 'Partido cancelado',
    champion: 'Campeón', runnerUp: 'Subcampeón', topScorer: 'Goleador', bestPlayer: 'Mejor jugador',
    notPickedChampion: 'Campeón (sin elegir)', notPickedRunnerUp: 'Subcampeón (sin elegir)',
    notPickedTopScorer: 'Goleador (sin elegir)', notPickedBestPlayer: 'Mejor jugador (sin elegir)',
  },
  'pt-BR': {
    exact: 'Placar exato', outcome: 'Resultado correto', wrong: 'Resultado incorreto',
    noPrediction: 'Sem palpite', cancelled: 'Partida cancelada',
    champion: 'Campeão', runnerUp: 'Vice-campeão', topScorer: 'Artilheiro', bestPlayer: 'Melhor jogador',
    notPickedChampion: 'Campeão (não escolhido)', notPickedRunnerUp: 'Vice-campeão (não escolhido)',
    notPickedTopScorer: 'Artilheiro (não escolhido)', notPickedBestPlayer: 'Melhor jogador (não escolhido)',
  },
};

/** Human label for a score_event source, in the given locale. */
export function formatScoreSource(source: ScoreEventSource, locale: BreakdownLocale): string {
  return LABELS[locale][SOURCE_TO_KEY[source]];
}

/** Sum the points across a set of score events. */
export function sumPoints(events: readonly { points: number }[]): number {
  return events.reduce((acc, e) => acc + e.points, 0);
}
