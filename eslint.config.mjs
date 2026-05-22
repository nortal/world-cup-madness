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
      // Constitution §1.3 — structured error logging on failure paths is
      // required ("no silent failures"). `console.error` and `console.warn`
      // are the chosen mechanism for that on the client (Server Components
      // log via Next's built-in logger). Only ad-hoc `console.log` debugging
      // is discouraged.
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      // Strict TS hygiene — discourage `any` without blocking initial scaffolding
      '@typescript-eslint/no-explicit-any': 'warn',
      // Honor the underscore-prefix convention for intentionally-unused
      // function args and variables (standard TS / @typescript-eslint
      // convention). Lets components declare stable extension-point props
      // without lint noise (see `components/auth/WelcomeModal.tsx` `_props`).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
];

export default config;
