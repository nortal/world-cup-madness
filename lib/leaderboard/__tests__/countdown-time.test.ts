import { describe, it, expect } from '@jest/globals';

import { formatCountdownTarget, formatRelativeCountdown } from '../countdown-time';

describe('formatCountdownTarget', () => {
  // 2026 World Cup opener — Mexico City kickoff on 2026-06-12 18:00 UTC.
  const firstKickoff = new Date('2026-06-12T18:00:00Z');

  it('formats the absolute date in English with the long date style', () => {
    const out = formatCountdownTarget(firstKickoff, 'America/Sao_Paulo', 'en');
    // June 12 in São Paulo (UTC-3) = 15:00. Substring check keeps the test
    // resilient to ICU minor-version punctuation drift ("at" vs comma).
    expect(out).toContain('June');
    expect(out).toContain('2026');
  });

  it('formats the absolute date in Spanish with the long date style', () => {
    const out = formatCountdownTarget(firstKickoff, 'America/Sao_Paulo', 'es');
    expect(out).toContain('junio');
    expect(out).toContain('2026');
  });

  it('formats the absolute date in pt-BR without errors', () => {
    const out = formatCountdownTarget(firstKickoff, 'America/Sao_Paulo', 'pt-BR');
    expect(out).toContain('junho');
    expect(out).toContain('2026');
  });

  it('respects the participant timezone (UTC vs São Paulo render different times)', () => {
    const utcLabel = formatCountdownTarget(firstKickoff, 'UTC', 'en');
    const spLabel = formatCountdownTarget(firstKickoff, 'America/Sao_Paulo', 'en');
    expect(utcLabel).not.toBe(spLabel);
  });
});

describe('formatRelativeCountdown', () => {
  it('renders a target ~5 days in the future using the "day" unit', () => {
    const now = new Date('2026-06-07T18:00:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'en');
    expect(out).toContain('5');
    expect(out.toLowerCase()).toContain('day');
  });

  it('renders a target ~3 hours in the future using the "hour" unit', () => {
    const now = new Date('2026-06-12T15:00:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'en');
    expect(out).toContain('3');
    expect(out.toLowerCase()).toContain('hour');
  });

  it('renders a target ~2 minutes in the future using the "minute" unit', () => {
    const now = new Date('2026-06-12T17:58:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'en');
    expect(out).toContain('2');
    expect(out.toLowerCase()).toContain('minute');
  });

  it('renders "now" when the target is exactly the current time (delta = 0)', () => {
    const now = new Date('2026-06-12T18:00:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'en');
    // `Intl.RelativeTimeFormat(en, {numeric: 'auto'})` renders 0 seconds as
    // "now". Lowercasing keeps the test stable against capitalisation.
    expect(out.toLowerCase()).toContain('now');
  });

  it('renders "now" when the target is already in the past (defensive fallback)', () => {
    const now = new Date('2026-06-12T18:05:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'en');
    expect(out.toLowerCase()).toContain('now');
  });

  it('renders the same magnitude in Spanish using locale-specific words', () => {
    const now = new Date('2026-06-07T18:00:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'es');
    expect(out).toContain('5');
    // Spanish renders "in 5 days" as "dentro de 5 días" — match the unit
    // root to stay tolerant of ICU minor preposition drift.
    expect(out.toLowerCase()).toContain('día');
  });

  it('renders without errors for pt-BR', () => {
    const now = new Date('2026-06-07T18:00:00Z');
    const target = new Date('2026-06-12T18:00:00Z');
    const out = formatRelativeCountdown(target, now, 'pt-BR');
    expect(out).toContain('5');
    expect(typeof out).toBe('string');
  });
});
