# Quickstart: Authentication and Participant Provisioning

**Feature**: 001-authentication-and-participant
**Audience**: Developer running this feature locally for the first time

## Prerequisites

- Node.js 20+ (`node --version`)
- Docker Desktop (for the local Supabase stack)
- Supabase CLI: `npm install -g supabase`

## 1. Install dependencies

```bash
cd project-repos/world-cup-madness
npm install
```

Adds `next`, `react`, `@supabase/supabase-js`, `@supabase/ssr`, `next-intl`, `tailwindcss`, plus dev deps (`@playwright/test`, `@axe-core/playwright`, `jest`, `@testing-library/react`).

## 2. Start the local Supabase stack

```bash
npx supabase start
```

Brings up Postgres, PostgREST, GoTrue (Auth), Inbucket (email), and Studio. Note the printed `anon key` and `service_role key`.

## 3. Apply migrations

```bash
npx supabase db reset
```

Runs all `supabase/migrations/*.sql` against the local DB. Verifies `citext` extension installed; tables, triggers, RLS policies, and functions all created.

## 4. Seed local config

Open `supabase/seed.sql` (or edit the `0009_seed_admin.sql` migration) and set:

- `nortal_tenant_id` — for local dev, use a test UUID like `'12345678-aaaa-bbbb-cccc-000000000000'`
- `admin_oids` — array containing your test admin's Microsoft OID (any UUID for local dev)

Re-run `npx supabase db reset`.

## 5. Configure local env

Create `.env.local` in `project-repos/world-cup-madness/`:

```env
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from step 2>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from step 2>
AUTH_AZURE_CLIENT_ID=<from Nortal IT, OR a test value if using JWT-injection only>
AUTH_AZURE_SECRET=<from Nortal IT, OR a test value>
```

## 6. Configure Microsoft OAuth provider (local)

Edit `supabase/config.toml`:

```toml
[auth.external.azure]
enabled       = true
client_id     = "env(AUTH_AZURE_CLIENT_ID)"
secret        = "env(AUTH_AZURE_SECRET)"
url           = "https://login.microsoftonline.com/common/v2.0"
redirect_uri  = "http://localhost:54321/auth/v1/callback"
```

For **local-only testing without real Microsoft OAuth**, skip this and use the test JWT-injection helper at `e2e/fixtures/auth.ts` (see Step 9). CI uses this path so it doesn't depend on Microsoft Entra.

## 7. Run the dev server

```bash
npm run dev
```

Open `http://localhost:3000`.

## 8. Verify the auth flow manually

### Eligible user happy path
1. Click **Sign in with Microsoft** on the landing page.
2. (With real OAuth) authenticate with a Microsoft account whose tenant ID matches the seeded `nortal_tenant_id`.
3. You should land on `/dashboard` with the welcome modal visible.
4. Dismiss the welcome modal.
5. Refresh — the modal should NOT reappear.
6. Open Supabase Studio (http://localhost:54323) → SQL Editor → run:
   ```sql
   SELECT action, occurred_at, actor_email FROM audit_log ORDER BY occurred_at DESC LIMIT 10;
   ```
   You should see `participant.created` and (for the dismissal) `participant.updated` rows.

### Ineligible user rejection path
1. Sign out.
2. Sign in with a Microsoft account whose tenant ID does NOT match the seed (or use the test ineligible JWT).
3. You should land on `/access-denied`.
4. Audit log should show an `auth.rejected` row with `actor_oid + actor_email + attempted_tid` populated, and **no new `participants` row**.

### Provider failure path
1. Stop the local Supabase stack mid-OAuth (`npx supabase stop`).
2. Click **Sign in with Microsoft** — exchange will fail.
3. You should land on `/auth-error` with a Retry CTA.

## 9. Run tests

```bash
# pgTAP tests (RLS + SECURITY DEFINER functions)
npx supabase db test

# Playwright E2E (uses JWT injection — no real Microsoft OAuth needed)
npx playwright test

# Unit tests (Jest + RTL)
npm test

# Lint
npm run lint

# Type-check
npx tsc --noEmit
```

## 10. Verify accessibility

```bash
npx playwright test --project=accessibility
```

Runs `@axe-core/playwright` against welcome modal, `/access-denied`, `/auth-error`, `/privacy`, profile.

## 11. Verify localization

```bash
npx playwright test e2e/tests/i18n-locale-detection.spec.ts
```

Runs Playwright with three `Accept-Language` headers (`en`, `es`, `pt-BR`) and asserts content matches expected locale.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npx supabase start` hangs | Docker Desktop not running | Start Docker |
| Sign-in returns 500 | `tournament_config.nortal_tenant_id IS NULL` | Re-run `supabase db reset` after editing seed |
| All sign-ins land on `/access-denied` | Test Microsoft account is in a different tenant than seeded | Use a matching test JWT, or re-seed with the right tenant ID |
| RLS test fails for `participants_public` view | View not granted to `authenticated` | Verify `0008_rls_policies.sql` ran |
| `service_role` key visible in browser bundle | Imported into a Client Component | Move to Server Component or Route Handler only |
| Welcome modal reappears after dismissal | `dismiss_welcome()` RPC failed silently | Check browser console + Supabase Studio logs; pgTAP test 002 should catch this |
