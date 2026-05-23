# API Contracts: Authentication and Participant Provisioning

Most data access goes through Supabase **PostgREST** (auto-generated REST endpoints over tables visible to the calling role under RLS). Custom logic uses **RPC** — Postgres functions exposed at `POST /rest/v1/rpc/{function_name}`.

## RPC contracts

| Function | File | Purpose |
|---|---|---|
| `provision_participant_from_jwt()` | [rpc-provision-participant.md](./rpc-provision-participant.md) | Called by Next.js auth callback after Supabase Auth returns a session; provisions or updates the participant row, returns outcome |
| `update_display_name(new_name TEXT)` | [rpc-update-display-name.md](./rpc-update-display-name.md) | Profile-page edit |
| `dismiss_welcome()` | [rpc-dismiss-welcome.md](./rpc-dismiss-welcome.md) | Welcome-modal dismissal |
| `record_auth_failure(...)` | [rpc-record-auth-failure.md](./rpc-record-auth-failure.md) | Internal helper for writing `auth.rejected` / `auth.provider-error` audit rows |

## PostgREST surface

| Table / View | Allowed operations | RLS-gated |
|---|---|---|
| `participants` | SELECT (own row + active rows for leaderboard); admin: SELECT all | Yes |
| `participants_public` (view) | SELECT (excludes `email`) | Yes (inherits underlying table policy) |
| `tournament_config` | SELECT (so RLS predicate can read tenant_id) | Yes |
| `audit_log` | SELECT (admin only) | Yes |

INSERT / UPDATE / DELETE on `participants` and `audit_log` is **forbidden** from the `authenticated` role; all mutations go through SECURITY DEFINER functions.

## Auth callback (Next.js Route Handler — not an RPC)

Route handler at `app/auth/callback/route.ts`:

1. Receives the OAuth callback from Microsoft via Supabase Auth (carries an authorization code).
2. Calls `supabase.auth.exchangeCodeForSession(code)`. On failure → call `record_auth_failure('auth.provider-error', null, null, null, 'callback.exchange-failed')` then redirect to `/auth-error`.
3. Calls the `provision_participant_from_jwt()` RPC.
4. Routes based on the returned `outcome`:
   - `success` → `/dashboard` (with `is_first_login` driving welcome-modal visibility on the dashboard server render)
   - `rejected` → `/access-denied`
   - `error` → `/auth-error`

See [rpc-provision-participant.md](./rpc-provision-participant.md) for the function contract; the route handler logic itself is implementation detail (no separate contract needed).

## Conventions

- All RPC requests are `POST` with JSON body (or empty `{}` for no-arg functions).
- All RPC responses return `200 OK` with a JSON body containing an `outcome` field for the happy path; errors raise SQLSTATE codes mapped to HTTP status by PostgREST (e.g. `check_violation` → 400, `no_data_found` → 404, `insufficient_privilege` → 401/403).
- `service_role` is required only by the auth callback Route Handler when it needs to bypass RLS for the auth-failure logging path before a user session exists. Never used in browser context.
