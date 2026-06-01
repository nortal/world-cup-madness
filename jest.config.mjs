// Jest config for World Cup Madness unit tests.
//
// Uses `next/jest` so TypeScript, path aliases (`@/`), and the same
// transform pipeline Next.js uses for the app code apply to tests without
// extra babel/ts-jest setup.
//
// Scope: pure-function units only (e.g. `lib/i18n/accept-language.ts`,
// `lib/i18n/config.ts`). DB-level invariants live in pgTAP
// (`test/pgtap/`); UI flows live in Playwright (`e2e/tests/`).

import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

const config = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/lib/**/__tests__/**/*.test.ts'],
};

export default createJestConfig(config);
