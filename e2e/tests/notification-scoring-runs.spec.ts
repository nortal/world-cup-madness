/**
 * Playwright E2E — feature 006 US2, task T014.
 *
 * Covers TC-O2: same notification + audit pipeline as US1 but the trigger
 * source is `scoring_runs.outcome='error'`. The trigger function
 * (`notify_teams_on_runs_error`) is the same — only the table it's
 * attached to differs (per migration 0039).
 *
 * Key difference from US1: `scoring_runs.id` is a UUID, so
 * `audit_log.entity_id` IS populated for this story. The trigger function
 * branches on TG_TABLE_NAME and routes the runbook URL to
 * `docs/runbooks/scoring-failure.md`.
 *
 * Owned provider_id range: 9811-9820 (markers on scoring_runs.action; no
 * match seeding needed — scoring_runs is its own telemetry table).
 */

import { execSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const MOCK_URL_OK = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=200';

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

test.describe('US2 — Teams notification + audit for scoring_runs errors', () => {
  test.setTimeout(90_000);

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await client.from('_test_mock_teams_inbox').delete().neq('id', -1);
    // Clear any in-flight scoring_runs row left over from prior test runs —
    // scoring_runs has a partial unique index `at_most_one_in_flight_per_action`
    // that rejects a second open row per action.
    await client
      .from('scoring_runs')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await client
      .from('audit_log')
      .delete()
      .in('action', ['notification.teams.sent', 'notification.teams.failed']);
  });

  test.afterAll(async () => {
    unsetWebhookUrl();
  });

  test('TC-O2: scoring_runs error fires Teams POST routed to scoring-failure runbook', async () => {
    await setWebhookUrl(MOCK_URL_OK);

    const client = getServiceRoleClient();

    // Seed: scoring_runs row mimicking a failed admin-recalc-all. Include
    // two PII shapes (participant_id + match_id UUIDs) so we can verify the
    // scrubber works for the scoring path too.
    const piiParticipant = '11223344-5566-7788-99aa-bbccddeeff00';
    const piiMatch = 'ffeeddcc-bbaa-9988-7766-554433221100';
    const errMsg = `recalculate_all_scores raised SQLSTATE 23503 for participant ${piiParticipant} on match ${piiMatch}.`;
    const { data: run, error: insertErr } = await client
      .from('scoring_runs')
      .insert({
        action: 'admin-recalc-all',
        status: 'error',
        error_message: errMsg,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as never)
      .select('id')
      .single();
    if (insertErr || !run) throw new Error(`scoring_runs insert failed: ${insertErr?.message}`);

    await waitForInboxCount(client, 1);

    const { data: inbox } = await client
      .from('_test_mock_teams_inbox')
      .select('body, status_sent')
      .order('id', { ascending: false })
      .limit(1)
      .single();
    expect(inbox).not.toBeNull();
    expect(inbox!.status_sent).toBe(200);

    const text = (inbox!.body as { text?: string }).text ?? '';
    // TC-O2 — Teams message references scoring_runs and the scoring runbook.
    expect(text).toContain('**WCM scoring_runs error**');
    expect(text).toContain('scoring-failure.md');
    // PII scrub applies — both UUIDs gone.
    expect(text).not.toContain(piiParticipant);
    expect(text).not.toContain(piiMatch);
    expect(text).toContain('[REDACTED]');
    // Non-PII context (SQLSTATE) survives.
    expect(text).toContain('SQLSTATE 23503');

    // Audit row: scoring_runs.id is a UUID, so entity_id IS populated.
    const { data: sentRows } = await client
      .from('audit_log')
      .select('id, entity_type, entity_id, new_value')
      .eq('action', 'notification.teams.sent');
    const ourSentRow = (sentRows ?? []).find(
      (r) => ((r.new_value as { run_id?: string }).run_id ?? '') === String(run.id),
    );
    expect(ourSentRow).toBeDefined();
    expect(ourSentRow!.entity_type).toBe('scoring_runs');
    // entity_id is UUID for scoring_runs (unlike integration_runs which is bigserial)
    expect(ourSentRow!.entity_id).toBe(run.id);

    // Reconciler tick → http_status=200 lands on the sent row.
    await forceReconcile();
    await new Promise((r) => setTimeout(r, 500));
    const { data: postReconcile } = await client
      .from('audit_log')
      .select('new_value')
      .eq('id', ourSentRow!.id)
      .single();
    expect(
      ((postReconcile?.new_value as { http_status?: number }) ?? {}).http_status,
    ).toBe(200);
  });
});
