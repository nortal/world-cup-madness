import { getTranslations } from 'next-intl/server';

/**
 * Plain `<select>` over the 32-team catalog (feature 003 US-PB / FR-P07).
 *
 * Server Component. 32 options is small enough for native select UX; no
 * combobox / type-ahead needed.
 */

export type TeamOption = {
  id: string;
  name: string;
  tla: string;
};

type TeamPickerProps = {
  name: string;
  labelKey: 'final.championLabel' | 'final.runnerUpLabel';
  selectedTeamId: string | null;
  teams: readonly TeamOption[];
};

export default async function TeamPicker({
  name,
  labelKey,
  selectedTeamId,
  teams,
}: TeamPickerProps) {
  const t = await getTranslations('predictions');
  const inputId = `team-picker-${name}`;

  return (
    <div className="flex flex-col">
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {t(labelKey)}
      </label>
      <select
        id={inputId}
        name={name}
        defaultValue={selectedTeamId ?? ''}
        className="mt-1 rounded-md border-gray-300 px-3 py-2 text-base"
      >
        <option value="">{t('final.noPickPlaceholder')}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name} ({team.tla})
          </option>
        ))}
      </select>
    </div>
  );
}
