#!/usr/bin/env bash
# Secret-hygiene CI guard — feature 006 T003 / FR-O06 + NFR-O05 + TC-O7.
#
# The Microsoft Teams incoming-webhook URL is a secret. It MUST NEVER appear
# in any git-tracked file. This script greps the entire repo (excluding the
# docs/ tree, which is allowed to reference the URL pattern as documentation)
# for any sign of a Teams webhook URL. Exits non-zero on any match.
#
# Run via pre-commit hook AND in CI (added to the test matrix once Phase 2 lands).

set -euo pipefail

# Anchor on the canonical Teams incoming-webhook hostname. Two shapes:
#   - legacy: outlook.office.com/webhook/...
#   - nortal tenant: <tenant>.webhook.office.com/webhookb2/...
PATTERNS=(
    'webhook.office.com'
    'outlook.office.com/webhook'
)

EXCLUDE_DIRS=(
    ':(exclude)docs'
    ':(exclude)specs'
    ':(exclude)scripts/ci/secret-hygiene-grep.sh'
)

found=0
for pattern in "${PATTERNS[@]}"; do
    if git grep -nF "$pattern" -- . "${EXCLUDE_DIRS[@]}" 2>/dev/null; then
        echo ""
        echo "❌ Found Teams webhook URL pattern '$pattern' in the repo."
        echo "   The webhook URL is a SECRET — store it in Supabase project secrets"
        echo "   or Vercel server-side env vars only. See specs/006-phase-5-operational/spec.md FR-O06."
        found=1
    fi
done

if [[ $found -eq 0 ]]; then
    echo "✅ Secret hygiene OK — no Teams webhook URL patterns found in the repo."
fi

exit $found
