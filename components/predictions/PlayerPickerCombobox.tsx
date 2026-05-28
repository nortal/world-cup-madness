'use client';

import { useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Active player picker (feature 003 US-PB / FR-P07 + FR-P11).
 *
 * Client Component, WAI-ARIA combobox modelled on feature 002's
 * `<TimezonePicker/>` (the constitution-frontend.md row "Timezone picker UI"
 * documents the established hand-rolled pattern).
 *
 * Filters the ~160-player list by name on keystroke; keyboard navigation
 * via arrow + enter; outputs the selected ID via a hidden form input so
 * the parent `<FinalPredictionsForm/>` can read it from its FormData.
 */

export type PlayerOption = {
  id: string;
  name: string;
  position: string | null;
  teamTla: string;
};

type PlayerPickerComboboxProps = {
  name: string;
  labelKey: 'final.topScorerLabel' | 'final.bestPlayerLabel';
  selectedPlayerId: string | null;
  players: readonly PlayerOption[];
};

export default function PlayerPickerCombobox({
  name,
  labelKey,
  selectedPlayerId,
  players,
}: PlayerPickerComboboxProps) {
  const t = useTranslations('predictions');
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;

  const initialSelected = players.find((p) => p.id === selectedPlayerId) ?? null;
  const [selected, setSelected] = useState<PlayerOption | null>(initialSelected);
  const [filter, setFilter] = useState<string>(initialSelected?.name ?? '');
  const [open, setOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);

  // Filter clientside — 160 rows fits comfortably.
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return players;
    return players.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.teamTla.toLowerCase().includes(needle),
    );
  }, [filter, players]);

  // Safe highlight index — clamp to current filtered length.
  const safeHighlightedIndex = filtered.length === 0
    ? 0
    : Math.min(highlightedIndex, filtered.length - 1);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlightedIndex((idx) => Math.min(idx + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((idx) => Math.max(idx - 1, 0));
    } else if (e.key === 'Enter' && open && filtered[safeHighlightedIndex]) {
      e.preventDefault();
      const pick = filtered[safeHighlightedIndex];
      setSelected(pick);
      setFilter(pick.name);
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function handleSelect(player: PlayerOption) {
    setSelected(player);
    setFilter(player.name);
    setOpen(false);
  }

  return (
    <div className="flex flex-col">
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {t(labelKey)}
      </label>
      <div className="relative">
        <input
          id={inputId}
          data-testid={`player-combobox-${name}`}
          type="text"
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[safeHighlightedIndex] ? `${listboxId}-option-${filtered[safeHighlightedIndex].id}` : undefined}
          autoComplete="off"
          value={filter}
          placeholder={t('final.playerPlaceholder')}
          onChange={(e) => {
            setFilter(e.target.value);
            setOpen(true);
            setHighlightedIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          className="mt-1 w-full rounded-md border-gray-300 px-3 py-2 text-base"
        />
        <input type="hidden" name={name} value={selected?.id ?? ''} />

        {open && filtered.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg"
          >
            {filtered.slice(0, 50).map((player, idx) => {
              const isActive = idx === safeHighlightedIndex;
              return (
                <li
                  key={player.id}
                  id={`${listboxId}-option-${player.id}`}
                  role="option"
                  aria-selected={selected?.id === player.id}
                  className={`cursor-pointer px-3 py-2 text-sm ${isActive ? 'bg-blue-100' : 'hover:bg-gray-100'}`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent onBlur closing before click
                    handleSelect(player);
                  }}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                >
                  <span className="font-medium">{player.name}</span>
                  <span className="ml-2 text-xs text-gray-500">
                    {player.teamTla}{player.position ? ` · ${player.position}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {open && filtered.length === 0 && (
          <p className="mt-1 text-xs text-gray-500">{t('final.noMatchingPlayers')}</p>
        )}
      </div>
    </div>
  );
}
