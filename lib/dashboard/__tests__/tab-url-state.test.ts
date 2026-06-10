import { describe, it, expect } from '@jest/globals';

import { formatTabHref, parseTab } from '../tab-url-state';

describe('parseTab', () => {
  it('returns "today" for null', () => {
    expect(parseTab(null)).toBe('today');
  });

  it('returns "today" for undefined', () => {
    expect(parseTab(undefined)).toBe('today');
  });

  it('returns "today" for empty string', () => {
    expect(parseTab('')).toBe('today');
  });

  it('returns "today" for "today"', () => {
    expect(parseTab('today')).toBe('today');
  });

  it('returns "pool" for "pool"', () => {
    expect(parseTab('pool')).toBe('pool');
  });

  it('returns "today" for uppercase (case-sensitive)', () => {
    expect(parseTab('TODAY')).toBe('today');
  });

  it('returns "today" for unknown value', () => {
    expect(parseTab('garbage')).toBe('today');
  });
});

describe('formatTabHref', () => {
  it('produces href for "today"', () => {
    expect(formatTabHref('today')).toBe('/dashboard?tab=today');
  });

  it('produces href for "pool"', () => {
    expect(formatTabHref('pool')).toBe('/dashboard?tab=pool');
  });
});
