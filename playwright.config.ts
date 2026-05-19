import { defineConfig, devices } from '@playwright/test';
import { loadEnvConfig } from '@next/env';

// Load `.env.local` (and other Next.js-recognized env files) into `process.env`
// for both the webServer and the test workers. Next.js' dev server loads these
// automatically; the test workers do NOT, so without this the fixtures in
// `e2e/fixtures/db.ts` cannot resolve `NEXT_PUBLIC_SUPABASE_URL` /
// `SUPABASE_SERVICE_ROLE_KEY`.
loadEnvConfig(process.cwd());

/**
 * Playwright configuration for World Cup Madness E2E + accessibility tests.
 *
 * Layout:
 *   - All specs live under `e2e/tests/**`.
 *   - The default `chromium` project runs every spec.
 *   - The `accessibility` project targets only specs ending in `.a11y.spec.ts`,
 *     where each test injects `@axe-core/playwright` (via the auth fixture in
 *     `e2e/fixtures/auth.ts` — T034) to assert WCAG 2.1 AA compliance.
 *
 * Rationale for the `*.a11y.spec.ts` convention (vs. a tag/grep or globalSetup):
 *   - Keeps a11y assertions co-located with the functional flow they verify,
 *     so a single dev server / Supabase state-reset path is reused.
 *   - Lets CI run `--project=accessibility` independently and surface a clean
 *     a11y report without re-running every functional spec.
 *   - Avoids a global axe hook that would inject scans into specs that don't
 *     need them (e.g. JWT-injection / RLS specs from research R-7).
 *
 * See:
 *   - `specs/001-authentication-and-participant/plan.md` §Testing
 *   - `specs/001-authentication-and-participant/research.md` R-7 (JWT injection)
 *   - `.ai_project_memory/constitution-frontend.md` §VIII
 */
export default defineConfig({
  testDir: './e2e/tests',
  // Tests share a single Supabase DB and each `beforeEach` truncates
  // `participants` / `audit_log` / resets `tournament_config.admin_oids` via
  // `resetSupabaseState()` (see `e2e/fixtures/db.ts`). Running two specs
  // concurrently means one worker's reset can wipe rows another worker is
  // mid-test on — the symptom is `/dashboard` redirecting to `/` because the
  // expected participant row vanished. Per-test DB isolation would require
  // per-worker Supabase schemas; until that exists, serialize the suite.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'accessibility',
      testMatch: /.*a11y\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
