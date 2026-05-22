'use client';

import { useEffect } from 'react';

import { createClient } from '@/lib/supabase/client';

/**
 * Auto-detects the participant's browser timezone on first dashboard mount
 * and persists it via the `set_timezone` RPC (FR-M14 / T043).
 *
 * Behavior contract:
 *   - Renderless side-effect component: returns `null` so it produces no
 *     DOM and can be dropped anywhere in the tree without layout impact.
 *   - Reads the browser timezone via
 *     `Intl.DateTimeFormat().resolvedOptions().timeZone` and POSTs it to
 *     the `set_timezone(p_timezone text)` RPC defined in migration 0015.
 *   - The RPC is a one-shot upsert: its `WHERE timezone = 'UTC'` clause
 *     means a second invocation against an already-set column returns
 *     `{outcome: 'no-op'}` silently. The component is therefore safe to
 *     mount unconditionally (StrictMode double-render, multi-tab races),
 *     but the parent (T044 dashboard page) still gates the mount on
 *     `participant.timezone === 'UTC'` so we don't spend an RPC round-trip
 *     when the column is already personalised.
 *   - Error handling: failures are logged with structured context
 *     (Constitution §1.3) but never thrown — the dashboard must keep
 *     rendering. Next sign-in retries naturally because the RPC's WHERE
 *     clause still gates on `timezone = 'UTC'`.
 *
 * Spec references:
 *   - specs/002-match-catalog/spec.md FR-M14 — auto-detect participant
 *     timezone on first dashboard load.
 *   - supabase/migrations/0015_*.sql — `set_timezone` RPC contract.
 */

// Empty-object props on purpose — the parent (T044) decides when to mount,
// so this component needs no inputs. Declared explicitly to mirror
// WelcomeModal's stable extension point.
type TimezoneAutoDetectProps = Record<string, never>;

export default function TimezoneAutoDetect(
  _props: TimezoneAutoDetectProps = {} as TimezoneAutoDetectProps,
): null {
  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (browserTz === '' || browserTz === 'UTC') {
        // Browser detected UTC (or returned empty) — no improvement over
        // the stored default. Skip the RPC entirely.
        return;
      }

      const supabase = createClient();
      const { error } = await supabase.rpc('set_timezone', { p_timezone: browserTz });
      if (cancelled) return;
      if (error) {
        // Constitution §1.3 — structured log, no silent failure, no crash.
        // Acceptable degradation: next sign-in re-attempts (the RPC's
        // `WHERE timezone = 'UTC'` clause keeps retries safe).
        console.error('TimezoneAutoDetect: set_timezone RPC failed', {
          operation: 'TimezoneAutoDetect.run',
          code: error.code,
          message: error.message,
        });
      }
    }

    void run();

    // Defends against future evolution: if this component ever calls
    // setState after the await, the cancelled flag prevents the classic
    // "setState on unmounted component" warning under React StrictMode.
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
