import { getTranslations } from 'next-intl/server';

/**
 * Visible-but-disabled state of the player picker (feature 003 US-PB / FR-P11).
 *
 * Server Component. Rendered when `players` table is empty (i.e. squads
 * haven't been synced yet). Auto-replaces with `<PlayerPickerCombobox/>`
 * once at least one player row exists.
 *
 * Uses semantic `aria-disabled` on a real input element + a sibling notice
 * with `aria-describedby` linking — axe-core clean.
 */

type PlayerPickerDisabledProps = {
  name: string;
  labelKey: 'final.topScorerLabel' | 'final.bestPlayerLabel';
};

export default async function PlayerPickerDisabled({
  name,
  labelKey,
}: PlayerPickerDisabledProps) {
  const t = await getTranslations('predictions');
  const inputId = `player-picker-${name}`;
  const noticeId = `${inputId}-notice`;

  return (
    <div className="flex flex-col">
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {t(labelKey)}
      </label>
      <input
        id={inputId}
        name={name}
        data-testid={`player-picker-disabled-${name}`}
        type="text"
        role="combobox"
        aria-controls={`${inputId}-listbox-placeholder`}
        aria-expanded="false"
        aria-disabled="true"
        aria-describedby={noticeId}
        readOnly
        placeholder={t('final.rostersPendingPlaceholder')}
        className="mt-1 cursor-not-allowed rounded-md border-gray-200 bg-gray-100 px-3 py-2 text-base text-gray-500"
      />
      <p id={noticeId} className="mt-1 text-xs text-gray-600">
        {t('final.rostersPendingNotice')}
      </p>
    </div>
  );
}
