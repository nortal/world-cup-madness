# World Cup Madness

An internal Nortal prediction pool for the FIFA World Cup 2026 — a "March Madness for soccer." Eligible Nortal employees sign in via corporate identity, predict match scores (locked one hour before kickoff) plus four tournament-wide picks (champion, runner-up, top scorer, best player; locked at first kickoff), and compete on a live leaderboard scored automatically against official results.

## Where to start

- [docs/architecture/README.md](docs/architecture/README.md) — index of all product/architecture artifacts
- [docs/architecture/high-level-architecture.md](docs/architecture/high-level-architecture.md) — full Nortal architecture document
- [docs/architecture/acceptance-criteria.md](docs/architecture/acceptance-criteria.md) — test scenarios and acceptance criteria
- [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md) — unresolved questions (OD-001…OD-008)
- [docs/architecture/scoring-model.md](docs/architecture/scoring-model.md) — locking + scoring + tie-breakers
- [docs/architecture/stack-decision.md](docs/architecture/stack-decision.md) — proposed implementation stack (draft ADR)

## Repository infrastructure

This repository uses a standardized pattern for:
- **Repository organization** via an auto-generated INDEX
- **Secret management** with local plaintext (gitignored) and encrypted (committed) secrets using age
- **Pre-commit enforcement** to prevent accidental secret leaks
- **Claude Code integration** with startup instructions

## Quick Start

### First-Time Setup

```bash
# Clone the repository
git clone <repository-url>
cd <repository-name>

# Run bootstrap (requires age to be installed)
./scripts/bootstrap.sh
```

### Prerequisites

| Tool | Check | Install (macOS) |
|------|-------|-----------------|
| Git 2.9+ | `git --version` | `brew install git` |
| Python 3.9+ | `python3 --version` | `brew install python` |
| age | `age --version` | `brew install age` |

## Directory Structure

```
.
├── .claude/           # Claude Code instructions
├── .githooks/         # Git hooks (pre-commit)
├── docs/              # Documentation
├── scripts/           # Automation scripts
│   ├── bootstrap.sh   # First-time setup
│   ├── install_hooks.sh
│   ├── index/         # INDEX.md generation
│   └── secrets/       # Secret encryption/decryption
├── secrets/
│   ├── plain/         # Plaintext secrets (gitignored)
│   ├── enc/           # Encrypted secrets (committed)
│   ├── recipients.txt # Public keys for encryption
│   └── manifest.json  # Secret metadata
├── CLAUDE.md          # Project nickname and agent rules
├── CLAUDE_START.md    # Agent getting started guide
├── INDEX.md           # Repository map (auto-generated)
└── README.md          # This file
```

## Secrets Workflow

### Creating Secrets

1. Create plaintext file in `secrets/plain/`:
   ```bash
   echo "API_KEY=secret123" > secrets/plain/my_secret.env
   ```

2. Encrypt all secrets:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

3. Commit encrypted files:
   ```bash
   git add secrets/enc/ secrets/manifest.json
   git commit -m "Add encrypted secret"
   ```

### Decrypting Secrets

After cloning or pulling:
```bash
./scripts/secrets/decrypt_all.sh
```

### Adding Team Members

1. Get their public key (they run `age-keygen` and share the `age1...` line)
2. Add to `secrets/recipients.txt`
3. Re-encrypt: `./scripts/secrets/encrypt_all.sh`
4. Commit and push

## Pre-commit Hook

The pre-commit hook blocks commits containing:
- Files in `secrets/plain/`
- Files matching `*.env`, `.env.*`, `*.pem`, `*.key`, `credentials.*`

To bypass (not recommended):
```bash
git commit --no-verify
```

## INDEX.md

The repository map in INDEX.md is auto-generated. To update:
```bash
./scripts/index/generate.sh
```

Human-editable sections are preserved across regenerations.

## Claude Code Integration

This repository is configured for Claude Code with:
- `CLAUDE_START.md` - Entry point for agents
- `CLAUDE.md` - Project nickname and behavior rules
- `.claude/instructions.md` - Detailed agent guidance
- `INDEX.md` - Repository structure for context

Agents are instructed to read these files first in any session.

---

## Feature 001 — Authentication and participant provisioning

**Spec:** [`specs/001-authentication-and-participant/`](specs/001-authentication-and-participant/) (FRs, TCs, ADRs)
**Setup guide:** [`specs/001-authentication-and-participant/quickstart.md`](specs/001-authentication-and-participant/quickstart.md) — step-by-step first-run instructions
**DoD report:** [`specs/001-authentication-and-participant/dod-verification.md`](specs/001-authentication-and-participant/dod-verification.md)

### Required environment variables

Copy `.env.example` to `.env.local` and fill from `npx supabase start` output (local) or your Supabase / Vercel project settings (deployed).

| Variable | Where it goes | Sourced from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Server + browser bundles | `npx supabase status -o env` (`API_URL`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Server + browser bundles | `npx supabase status -o env` (`ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** — never ship to client | `npx supabase status -o env` (`SERVICE_ROLE_KEY`) |
| `AUTH_AZURE_CLIENT_ID` | Supabase Auth provider config | Microsoft Entra app registration (Nortal IT) |
| `AUTH_AZURE_SECRET` | Supabase Auth provider config | Microsoft Entra app registration (Nortal IT) |
| `AUTH_AZURE_TENANT_ID` | Local dev: matches `tournament_config.nortal_tenant_id`; prod: Nortal tenant UUID | Nortal IT |

### Local test commands

```bash
# Unit (pure functions)
npm test

# E2E (chromium + accessibility projects)
npm run test:e2e
npm run test:a11y     # accessibility-only subset

# Database (pgTAP — needs `npx supabase start` first)
npx supabase db test test/pgtap/*.sql

# Static checks
npm run type-check
npm run lint
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run dev` returns 404 on every page including `/` | Stale `.next` cache from a Next or middleware change | `rm -rf .next && npm run dev` |
| Playwright timeout: `webServer didn't start within 120000ms` | Lingering `next dev` process holding port 3000 | `pkill -9 -f "next dev" && pkill -9 -f next-server`, then retry |
| `Supabase: failed to inspect container health` | Colima / Docker daemon not running | `colima start --cpu 4 --memory 4` (macOS); excludes `vector` per local convention: `npx supabase start --exclude vector` |
| pgTAP `Files=0, Tests=0, Result: NOTESTS` | Default test path doesn't pick up `test/pgtap/` | Pass paths explicitly: `npx supabase db test test/pgtap/*.sql` |
| Spanish / Portuguese sign-in shows English text | Stale `NEXT_LOCALE` cookie from a previous session | Clear browser cookies for `localhost:3000`; the middleware re-detects from `Accept-Language` on next request |
| `signInAs: admin.createUser failed for ...: Unable to validate email address` | Whitespace or invalid characters in test email | Supabase Auth's format validator rejects whitespace; use a clean email per the `e2e/fixtures/auth.ts` defaults |
| `infinite recursion detected in policy for relation 'participants'` | Stale local schema (pre-migration 0010) | `npx supabase db reset` — migration 0010 introduced the `is_admin_user()` SECURITY DEFINER helper that breaks the recursion |
