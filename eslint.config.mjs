// ESLint flat config for World Cup Madness
//
// NOTE: T004 originally specified `.eslintrc.json` (legacy format), but ESLint 9.x
// + eslint-config-next 16.x only support flat config. This file fulfills the
// intent of T004: extend `next/core-web-vitals`, add strict TS-flavored rules,
// and warn on console statements.

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // Constitution-frontend §VI.1 — flag console statements but don't fail builds
      'no-console': 'warn',
      // Strict TS hygiene — discourage `any` without blocking initial scaffolding
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
];

export default config;
