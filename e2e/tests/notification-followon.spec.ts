/**
 * Playwright E2E — feature 006 US3, task T020.
 *
 * Covers TC-O5 (no dedup — every error is a separate Teams message) and
 * TC-O6 (the match-window-readiness SQL bundle parses and returns rows
 * against a seeded local stack).
 *
 * TC-O5: insert two `integration_runs.outcome='error'` rows within 60 s,
 * force-tick the reconciler, assert the mock inbox grew by EXACTLY 2.
 * Per FR-O03c + DD-O1 — v1 sends every error; dedup is a deferred
 * decision. The test is a regression guard so a later dedup change
 * doesn't silently happen.
 *
 * TC-O6: read the SQL block from `docs/runbooks/match-window-readiness.md`,
 * execute each `\g`-separated query against psql via `docker exec`,
 * assert each query returns a parseable result without syntax error.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const MOCK_URL_OK = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=200';

async function setWebhookUrl(url: string): Promise<void> {
  execSync(
    `docker exec -e PGPASSWORD=postgres supabase_db_world-cup-madness psql -U supabase_admin -d postgres -c "ALTER DATABASE postgres SET app.teams_webhook_url = '${url}'; SELECT pg_reload_conf(); SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid <> pg_backend_pid() AND state IN ('idle', 'idle in transaction');"`,
    { stdio: 'pipe' },
  );
  await new Promise((r) => setTimeout(r, 1500));
}

async function forceReconcile(): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client.rpc('reconcile_teams_notifications_now' as never);
  if (error) throw new Error(`reconcile_teams_notifications_now failed: ${error.message}`);
}

async function waitForInboxCount(
  client: ReturnType<typeof getServiceRoleClient>,
  expected: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const { count } = await client
      .from('_test_mock_teams_inbox')
      .select('id', { head: true, count: 'exact' });
    if ((count ?? 0) >= expected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`inbox never reached ${expected} rows`);
}

test.describe('US3 — follow-on notification + health-check coverage', () => {
  test.setTimeout(90_000);

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await client.from('_test_mock_teams_inbox').delete().neq('id', -1);
    await client.from('integration_runs').delete().neq('id', -1);
    await client
      .from('audit_log')
      .delete()
      .in('action', ['notification.teams.sent', 'notification.teams.failed']);
  });

  test('TC-O5: two error rows within 60 s deliver two Teams messages (no dedup)', async () => {
    await setWebhookUrl(MOCK_URL_OK);

    const client = getServiceRoleClient();

    // Two distinct errors back-to-back.
    for (let i = 0; i < 2; i += 1) {
      const { error } = await client.from('integration_runs').insert({
        provider: 'football-data.org',
        action: 'bootstrap',
        status: 'error',
        error_message: `synthetic burst error ${i + 1}`,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as never);
      if (error) throw new Error(`integration_runs insert ${i + 1} failed: ${error.message}`);
    }

    // Both errors should hit the mock receiver — no dedup.
    await waitForInboxCount(client, 2);
    const { count } = await client
      .from('_test_mock_teams_inbox')
      .select('id', { head: true, count: 'exact' });
    expect(count, 'expected exactly 2 inbox rows, one per error').toBe(2);
  });

  test('TC-O6: match-window-readiness SQL block parses and returns rows', async () => {
    // Read the markdown, extract the fenced ```sql block, execute each
    // \g-separated query. Tolerance: each query must return at least 1
    // row OR succeed with 0 rows — never throw a parse error.
    const md = readFileSync(
      '/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/match-window-readiness.md',
      'utf-8',
    );
    const sqlMatch = md.match(/```sql\n([\s\S]*?)\n```/);
    expect(sqlMatch, 'match-window-readiness.md must contain a ```sql fenced block').not.toBeNull();
    const sqlBlock = sqlMatch![1];

    // Split on the psql \g separator. Trim. Drop empties.
    const queries = sqlBlock
      .split(/\n\\g\n?/)
      .map((q) => q.trim())
      .filter((q) => q.length > 0);

    expect(queries.length, 'expected at least 4 panes in the bundle').toBeGreaterThanOrEqual(4);

    // Run each query via docker exec. We only assert it didn't fail —
    // empty result sets are fine (e.g. no error-shaped audit rows).
    for (let i = 0; i < queries.length; i += 1) {
      const q = queries[i]!;
      // Escape single quotes for the docker exec shell wrapper.
      const escaped = q.replace(/'/g, "'\\''");
      try {
        execSync(
          `docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c '${escaped}'`,
          { stdio: 'pipe' },
        );
      } catch (err) {
        const e = err as Error & { stderr?: Buffer };
        throw new Error(
          `pane ${i + 1} failed:\n${(e.stderr ?? Buffer.from('')).toString()}\n\nSQL was:\n${q}`,
        );
      }
    }
  });
});
