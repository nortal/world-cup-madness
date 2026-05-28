import PlayerPickerCombobox, { type PlayerOption } from './PlayerPickerCombobox';
import PlayerPickerDisabled from './PlayerPickerDisabled';

/**
 * Server Component wrapper that decides between the disabled state and the
 * active combobox based on whether players have been synced (feature 003
 * US-PB / FR-P11).
 *
 * When `players.length === 0` → renders `<PlayerPickerDisabled/>` with
 * the rosters-pending notice. When players exist → renders the
 * `<PlayerPickerCombobox/>` Client Component with the full list.
 *
 * The decision is taken on the server based on the players prop, so the
 * UI doesn't need to round-trip to check after every navigation.
 */

type PlayerPickerProps = {
  name: string;
  labelKey: 'final.topScorerLabel' | 'final.bestPlayerLabel';
  selectedPlayerId: string | null;
  players: readonly PlayerOption[];
};

export default function PlayerPicker({
  name,
  labelKey,
  selectedPlayerId,
  players,
}: PlayerPickerProps) {
  if (players.length === 0) {
    return <PlayerPickerDisabled name={name} labelKey={labelKey} />;
  }
  return (
    <PlayerPickerCombobox
      name={name}
      labelKey={labelKey}
      selectedPlayerId={selectedPlayerId}
      players={players}
    />
  );
}
