/**
 * Playwright E2E — feature 006 US1, task T011.
 *
 * Covers TC-O1, TC-O9, TC-O10, TC-O11, TC-O12 for the `integration_runs`
 * notification path: synthetic error → Teams webhook POST → mock receiver
 * captures payload → audit_log carries `notification.teams.sent` →
 * reconciler updates `http_status` (200 path) or emits a separate
 * `notification.teams.failed` row (4xx path) → no retry on second tick.
 *
 * Why no `signInAs` / Playwright `page` usage: this entire pipeline is
 * server-side. We use the service-role client only and never open a
 * browser. The Playwright runner is here purely for the fixture harness
 * (`resetSupabaseState`, ownership of provider_id ranges, retry policy).
 *
 * Pre-test setup: the test points `app.teams_webhook_url` at the local
 * mock receiver Edge Function (running on port 54321). The mock writes
 * every received POST into `_test_mock_teams_inbox` so we can introspect.
 *
 * Owned provider_id range: 9801-9810 (only used as a marker on
 * integration_runs — no match seeding needed; integration_runs is its
 * own telemetry table).
 *
 * `test.setTimeout(90_000)` per describe: covers the cron reconciler
 * wait + service-role enqueue + mock receiver round-trip.
 */

import { execSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const MOCK_URL_OK = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=200';
const MOCK_URL_410 = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=410';
const MOCK_URL_500 = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=500';

/**
 * Set the trigger's webhook URL via `ALTER DATABASE` — the trigger reads
 * `current_setting('app.teams_webhook_url')` at fire time. We must use
 * the DB-level setting (not a session-local SET) because the trigger fires
 * in a different session than the test (pg_net's enqueue worker drains the
 * queue from its own connection).
 *
 * Uses `docker exec` because the supautils extension blocks the `postgres`
 * role from `ALTER DATABASE ... SET app.*` through PostgREST — only the
 * supabase_admin superuser can do it.
 */
/**
 * Set the trigger's webhook URL via `ALTER DATABASE` AND terminate every
 * existing backend so the new value is picked up. `app.teams_webhook_url`
 * is read via `current_setting()` inside the trigger, and `ALTER DATABASE
 * ... SET` only applies to NEW sessions — existing PostgREST + pg_net
 * worker sessions hold stale values until they reconnect. Terminating the
 * idle ones forces a fresh read on the next call.
 */
async function setWebhookUrl(url: string): Promise<void> {
  execSync(
    `docker exec -e PGPASSWORD=postgres supabase_db_world-cup-madness psql -U supabase_admin -d postgres -c "ALTER DATABASE postgres SET app.teams_webhook_url = '${url}'; SELECT pg_reload_conf(); SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres' AND pid <> pg_backend_pid() AND state IN ('idle', 'idle in transaction');"`,
    { stdio: 'pipe' },
  );
  // PostgREST + pg_net workers reconnect on their next call — give the
  // pool a moment to drop and re-establish so subsequent test queries see
  // the new app.teams_webhook_url value.
  await new Promise((r) => setTimeout(r, 1500));
}

function unsetWebhookUrl(): void {
  execSync(
    `docker exec -e PGPASSWORD=postgres supabase_db_world-cup-madness psql -U supabase_admin -d postgres -c "ALTER DATABASE postgres RESET app.teams_webhook_url; SELECT pg_reload_conf();"`,
    { stdio: 'pipe' },
  );
}

/**
 * Force-tick the reconciler so tests don't have to wait the 60 s cron
 * cadence. Per data-model.md §4 the wrapper `reconcile_teams_notifications_now()`
 * was specifically added for this.
 */
async function forceReconcile(): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client.rpc('reconcile_teams_notifications_now' as never);
  if (error) {
    throw new Error(`reconcile_teams_notifications_now failed: ${error.message}`);
  }
}

/**
 * Wait until the mock-receiver inbox count grows to the expected size,
 * polling at 250 ms intervals up to 10 s. pg_net's enqueue worker drains
 * the queue asynchronously; without a wait the test races the worker.
 */
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

test.describe('US1 — Teams notification + audit for integration_runs errors', () => {
  test.setTimeout(90_000);

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    // Clear the test mock inbox + any prior notification audit rows so
    // each test starts from a known zero baseline.
    await client.from('_test_mock_teams_inbox').delete().neq('id', -1);
    await client.from('integration_runs').delete().neq('id', -1);
    await client
      .from('audit_log')
      .delete()
      .in('action', ['notification.teams.sent', 'notification.teams.failed']);
  });

  test.afterAll(async () => {
    unsetWebhookUrl();
  });

  test('TC-O1 + TC-O9 + TC-O10: error fires PII-scrubbed Teams POST and audited', async () => {
    await setWebhookUrl(MOCK_URL_OK);

    const client = getServiceRoleClient();

    // Seed: insert an integration_runs row carrying every PII shape the
    // scrubber should redact (email, UUID, nortal.com domain).
    const piiEmail = 'alice@nortal.com';
    const piiUuid = '00112233-4455-6677-8899-aabbccddeeff';
    const errMsg = `Provider 5xx for ${piiEmail} on participant ${piiUuid} — nortal.com tenant filter timeout. SQLSTATE 22023.`;
    const { data: run, error: insertErr } = await client
      .from('integration_runs')
      .insert({
        provider: 'football-data.org',
        action: 'bootstrap',
        status: 'error',
        error_message: errMsg,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as never)
      .select('id')
      .single();
    if (insertErr || !run) throw new Error(`integration_runs insert failed: ${insertErr?.message}`);

    // pg_net.http_post enqueues asynchronously — wait until the mock has
    // recorded the receipt before asserting on the body.
    await waitForInboxCount(client, 1);

    // TC-O1 — the inbox has exactly one row pointed at our run.
    const { data: inbox } = await client
      .from('_test_mock_teams_inbox')
      .select('body, status_sent')
      .order('id', { ascending: false })
      .limit(1)
      .single();
    expect(inbox).not.toBeNull();
    expect(inbox!.status_sent).toBe(200);

    const text = (inbox!.body as { text?: string }).text ?? '';
    expect(text).toContain('**WCM integration_runs error**');
    expect(text).toContain('provider-sync-failure.md');

    // TC-O9 — every PII token replaced by [REDACTED]; non-PII context
    // (SQLSTATE) survives.
    expect(text).not.toContain(piiEmail);
    expect(text).not.toContain(piiUuid);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('SQLSTATE 22023');

    // TC-O10 — exactly one notification.teams.sent audit row references
    // this run via new_value.run_id.
    const { data: sentRows } = await client
      .from('audit_log')
      .select('id, action, entity_type, new_value, occurred_at')
      .eq('action', 'notification.teams.sent')
      .order('occurred_at', { ascending: false });
    expect(sentRows).not.toBeNull();
    const ourSentRow = sentRows!.find(
      (r) => ((r.new_value as { run_id?: string }).run_id ?? '') === String(run.id),
    );
    expect(ourSentRow, 'expected one notification.teams.sent row for this run').toBeDefined();
    expect(ourSentRow!.entity_type).toBe('integration_runs');
    const sentValue = ourSentRow!.new_value as { req_id?: number; http_status?: unknown };
    expect(typeof sentValue.req_id).toBe('number');
    expect(sentValue.http_status).toBeNull();

    // Force the reconciler tick → http_status should land 200.
    await forceReconcile();
    // Reconciler does an UPDATE — give Postgres a moment.
    await new Promise((r) => setTimeout(r, 500));
    const { data: postReconcile } = await client
      .from('audit_log')
      .select('new_value')
      .eq('id', ourSentRow!.id)
      .single();
    expect(
      ((postReconcile?.new_value as { http_status?: number }) ?? {}).http_status,
      'reconciler should set http_status=200 on a 2xx response',
    ).toBe(200);
  });

  test('TC-O11: webhook returns 4xx → notification.teams.failed audited', async () => {
    await setWebhookUrl(MOCK_URL_410);

    const client = getServiceRoleClient();
    const { data: run } = await client
      .from('integration_runs')
      .insert({
        provider: 'football-data.org',
        action: 'manual-resync',
        status: 'error',
        error_message: 'simulated revoked webhook',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as never)
      .select('id')
      .single();
    expect(run).not.toBeNull();

    await waitForInboxCount(client, 1);
    await forceReconcile();
    await new Promise((r) => setTimeout(r, 500));

    const { data: failedRows } = await client
      .from('audit_log')
      .select('new_value')
      .eq('action', 'notification.teams.failed');
    const ourFailedRow = (failedRows ?? []).find(
      (r) => ((r.new_value as { run_id?: string }).run_id ?? '') === String(run!.id),
    );
    expect(
      ourFailedRow,
      'expected one notification.teams.failed row for the 4xx delivery',
    ).toBeDefined();
    const failedValue = ourFailedRow!.new_value as {
      http_status?: number;
      retry_attempted?: boolean;
    };
    expect(failedValue.http_status).toBe(410);
    expect(failedValue.retry_attempted).toBe(false);
  });

  test('TC-O12: 5xx delivery never retries even on a second reconciler tick', async () => {
    await setWebhookUrl(MOCK_URL_500);

    const client = getServiceRoleClient();
    const { data: run } = await client
      .from('integration_runs')
      .insert({
        provider: 'football-data.org',
        action: 'incremental-sync',
        status: 'error',
        error_message: 'sustained 5xx scenario',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as never)
      .select('id')
      .single();
    expect(run).not.toBeNull();

    await waitForInboxCount(client, 1);
    await forceReconcile();
    await new Promise((r) => setTimeout(r, 500));

    // First tick should produce exactly ONE failed row for this run.
    const { data: afterFirst } = await client
      .from('audit_log')
      .select('id, new_value')
      .eq('action', 'notification.teams.failed');
    const ourRunFailedRows = (afterFirst ?? []).filter(
      (r) => ((r.new_value as { run_id?: string }).run_id ?? '') === String(run!.id),
    );
    expect(ourRunFailedRows.length, 'one failed row per req_id after first reconcile').toBe(1);

    // Second tick: no new POST to the inbox, no second failed row for the
    // same run. FR-O03c — one-shot, no retry.
    await forceReconcile();
    await new Promise((r) => setTimeout(r, 500));
    const { count: inboxCountAfter } = await client
      .from('_test_mock_teams_inbox')
      .select('id', { head: true, count: 'exact' });
    expect(inboxCountAfter, 'second reconcile must not re-POST to the mock receiver').toBe(1);

    const { data: afterSecond } = await client
      .from('audit_log')
      .select('id, new_value')
      .eq('action', 'notification.teams.failed');
    const stillOne = (afterSecond ?? []).filter(
      (r) => ((r.new_value as { run_id?: string }).run_id ?? '') === String(run!.id),
    );
    expect(stillOne.length, 'no second failed row created on second reconcile').toBe(1);
  });
});
