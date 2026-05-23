/**
 * Playwright E2E test — TC-13 (email case-insensitive uniqueness) for US1.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` §TC-13
 *   > Email case-insensitive uniqueness — Given a Microsoft Entra account whose
 *   > `email` claim is sent as `Mike@Nortal.com` on the very first sign-in
 *   > (stored as `mike@nortal.com`), when the same `oid` later signs in with
 *   > email claim `MIKE@NORTAL.COM` or `  mike@nortal.com  ` (with whitespace),
 *   > then the existing participant row is matched (lookup by canonical form),
 *   > no duplicate row is created, and the stored email value remains
 *   > `mike@nortal.com`.
 *
 * End-to-end canonicalization path (verified by running the test against the
 * local Supabase stack):
 *   1. The Playwright fixture passes a mixed-case email (e.g. `Mike@Nortal.com`)
 *      to `auth.admin.createUser`. **Supabase Auth normalizes emails to
 *      lowercase at the auth-layer** before persisting `auth.users.email`, so
 *      the row is stored as `mike@nortal.com` and every subsequent
 *      Supabase-issued JWT carries the lowercase form in its top-level `email`
 *      claim.
 *   2. The provisioning RPC `provision_participant_from_jwt()` (migration
 *      0010) reads `email = auth.jwt() ->> 'email'` — already lowercase by the
 *      time it lands here.
 *   3. The BEFORE INSERT/UPDATE trigger `trim_participant_email()` (migration
 *      0003) strips surrounding whitespace from `NEW.email::text`. It does
 *      NOT change letter case — and never needs to, because step (1) already
 *      lowercased it.
 *   4. `participants.email` is declared `citext`, which makes the UNIQUE
 *      constraint and any comparisons case-insensitive. This is defense in
 *      depth — if a future code path inserts a mixed-case email directly
 *      (bypassing Supabase Auth), uniqueness still holds.
 *   5. The RPC looks up the participant by `oid`, NOT by email. On a returning
 *      sign-in it re-sets `participants.email = (jwt ->> 'email')`, so the
 *      stored email always reflects the most recent JWT's value (after the
 *      Auth lowercase + trigger trim).
 *
 * Consequence for this E2E test:
 *   - Storage is observably lowercase (spec text is accurate, end-to-end).
 *   - The mechanism is *Supabase Auth normalization*, NOT a trigger or
 *     application-level lower(). pgTAP test 004 exercises direct INSERTs and
 *     therefore preserves case (it bypasses Supabase Auth); this E2E test
 *     exercises the full sign-in → JWT → RPC → row path and so observes the
 *     lowercase result.
 *   - The load-bearing TC-13 invariant is the single-row guarantee keyed by
 *     `oid`. That is asserted directly in both tests via `count: 'exact'`.
 *
 * pgTAP counterpart: `test/pgtap/004_email_normalization.sql` exercises the
 * uniqueness invariants at the database layer (direct INSERTs that bypass
 * Supabase Auth). T066 / this E2E exercises the full path through the
 * `signInAs` fixture and the `provision_participant_from_jwt()` RPC, so the
 * Auth-layer normalization participates and the stored value is lowercase.
 *
 * Test strategy (single describe, two tests):
 *   1. First sign-in with mixed-case email → exactly one participant row, oid
 *      preserved, email stored as `mike@nortal.com` (Auth-normalized
 *      lowercase).
 *   2. Same `oid`, second sign-in with uppercase email → still exactly one
 *      participant row (matched by oid), no duplicate created, email column
 *      still `mike@nortal.com`.
 *
 * Out of E2E scope (covered by pgTAP test 004):
 *   - Whitespace handling. Supabase Auth's email-format validator rejects
 *     whitespace-padded strings at `auth.admin.createUser` time, so the
 *     spec's `'  mike@nortal.com  '` variant is unreachable through the
 *     OAuth flow this test exercises. The `trim_participant_email()` trigger
 *     IS exercised end-to-end (it ran for both sign-ins below) but cannot
 *     observe whitespace-trimming behavior because Auth never lets such
 *     input through. pgTAP test 004 covers the trigger's whitespace branch
 *     with direct INSERTs that bypass Auth.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import {
  getParticipantByOid,
  getServiceRoleClient,
  resetSupabaseState,
} from '../fixtures/db';

/**
 * Re-invoke `provision_participant_from_jwt()` from the authenticated browser
 * context. Production code triggers this RPC inside `/auth/callback` after
 * `exchangeCodeForSession`; the JWT-injection fixture bypasses that handler,
 * so the test invokes the RPC explicitly to exercise the same provisioning
 * code path. Helper kept local — see TC-2 spec for the same pattern.
 */
async function provisionParticipantFromPage(
  page: import('@playwright/test').Page,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate the persisted session from cookies before issuing the RPC.
      // `createBrowserClient` returns synchronously but auth state hydrates
      // asynchronously; without this the RPC can race ahead unauthenticated.
      await client.auth.getSession();
      const { data, error } = await client.rpc('provision_participant_from_jwt');
      if (error !== null && error !== undefined) {
        return { ok: false as const, error: error.message };
      }
      return { ok: true as const, data };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

test.describe('TC-13: email case-insensitive uniqueness', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test('first sign-in with mixed-case email stores canonical lowercase value', async ({
    page,
  }) => {
    // Step 1: sign in with an explicit mixed-case email. The fixture writes
    // this value to `auth.users.email` AND mirrors it into
    // `user_metadata.email`; the JWT's top-level `email` claim is what the
    // provision RPC reads (migration 0010 line 94).
    const { oid } = await signInAs(page, {
      tenant: 'eligible',
      email: 'Mike@Nortal.com',
      name: 'Mike Test',
    });

    // Step 2: invoke the provisioning RPC. This is the production code path
    // that inserts the participant row (FR-003).
    const provision = await provisionParticipantFromPage(page);
    expect(provision.ok, 'provision_participant_from_jwt must succeed').toBe(true);

    // Step 3: read back the row by oid and assert canonicalization behavior.
    // Per the header docblock, Supabase Auth lowercases the email at the
    // `auth.users` layer before the JWT is issued, so the RPC inserts a
    // lowercase string and the trigger's trim is a no-op. Stored value =
    // lowercase + whitespace-free regardless of what the fixture passed in.
    const row = await getParticipantByOid(oid);
    expect(row, `participant row for oid=${oid} must exist after first sign-in`).not.toBeNull();
    const participant = row as NonNullable<typeof row>;
    expect(participant.oid).toBe(oid);
    expect(
      participant.email,
      'first sign-in: Supabase Auth lowercases at the user-creation layer; stored value reflects that',
    ).toBe('mike@nortal.com');

    // Step 4: confirm the single-row invariant — exactly one participant exists
    // globally for this freshly-reset state. `head: true` avoids fetching rows;
    // `count: 'exact'` makes PostgREST return the precise row count in the
    // response header.
    const serviceClient = getServiceRoleClient();
    const { count, error: countError } = await serviceClient
      .from('participants')
      .select('*', { count: 'exact', head: true });
    expect(countError, 'service-role count select must succeed').toBeNull();
    expect(count, 'exactly one participant row must exist after first sign-in').toBe(1);
  });

  test('re-sign-in with uppercase email matches existing oid and preserves canonical email', async ({
    page,
  }) => {
    // Step 1: first sign-in with mixed-case email (same setup as Test 1).
    const first = await signInAs(page, {
      tenant: 'eligible',
      email: 'Mike@Nortal.com',
      name: 'Mike Test',
    });
    const oid = first.oid;

    const firstProvision = await provisionParticipantFromPage(page);
    expect(firstProvision.ok, 'first provision RPC must succeed').toBe(true);

    // Sanity-check the seed state before the assertion under test.
    const baselineRow = await getParticipantByOid(oid);
    expect(baselineRow, 'baseline participant row must exist').not.toBeNull();
    const baseline = baselineRow as NonNullable<typeof baselineRow>;
    const baselineId = baseline.id;
    expect(baseline.email).toBe('mike@nortal.com');

    // Step 2: clear cookies so the second sign-in starts from a clean browser
    // state (no stale session leaks into the re-sign-in path).
    await page.context().clearCookies();

    // Step 3: re-sign-in with the SAME `oid` but a different-cased email.
    // NOTE on fixture semantics: `signInAs` keys `auth.users` by the supplied
    // email string, so passing a different string here creates a SEPARATE
    // `auth.users` row carrying the same `app_metadata.oid`. That is
    // acceptable — TC-13 is about `public.participants` uniqueness keyed by
    // oid, not about deduplication of `auth.users` rows. The provision RPC
    // looks up `public.participants` by oid (migration 0010 line 118), so the
    // existing participant row is found and updated rather than re-inserted.
    //
    // Note on whitespace: the spec's TC-13 text mentions a whitespace-padded
    // email variant (`'  mike@nortal.com  '`). That variant is unreachable
    // through the OAuth flow because Supabase Auth's email-format validator
    // rejects whitespace at `auth.admin.createUser` time. The whitespace
    // defense-in-depth is exercised at the database layer by
    // `test/pgtap/004_email_normalization.sql`, which inserts directly into
    // `public.participants` and asserts the `trim_participant_email()`
    // trigger strips surrounding whitespace. This E2E covers the realistic
    // OAuth-flow variant: case change only.
    await signInAs(page, {
      tenant: 'eligible',
      oid,
      email: 'MIKE@NORTAL.COM',
      name: 'Mike Test',
    });

    const secondProvision = await provisionParticipantFromPage(page);
    expect(secondProvision.ok, 'second provision RPC must succeed').toBe(true);

    // Step 4: re-read by oid and assert the same row was matched.
    const refreshedRow = await getParticipantByOid(oid);
    expect(refreshedRow, 'participant row must still exist after second sign-in').not.toBeNull();
    const refreshed = refreshedRow as NonNullable<typeof refreshedRow>;
    expect(
      refreshed.id,
      'participant row id must be unchanged — provision_participant_from_jwt matched by oid, not by email',
    ).toBe(baselineId);
    expect(refreshed.oid).toBe(oid);

    // Step 5: assert the stored email. The second JWT carries the
    // Auth-normalized lowercase `mike@nortal.com` regardless of the
    // mixed-case + whitespace string the fixture supplied to `createUser`,
    // because Supabase Auth performs that normalization at the user-creation
    // layer. The RPC re-sets `email = (jwt ->> 'email')` on the returning
    // branch (migration 0010 line ~129); the trigger trims (no-op) and the
    // result lands as lowercase.
    expect(
      refreshed.email,
      'returning sign-in: stored email is the Auth-normalized lowercase form',
    ).toBe('mike@nortal.com');

    // Step 6: confirm no duplicate participant row was created. Even though
    // `auth.users` now has two rows (one per distinct email string), the
    // `public.participants` table — keyed by oid — must contain exactly one
    // row. This is the load-bearing assertion for TC-13.
    const serviceClient = getServiceRoleClient();
    const { count, error: countError } = await serviceClient
      .from('participants')
      .select('*', { count: 'exact', head: true });
    expect(countError, 'service-role count select must succeed').toBeNull();
    expect(
      count,
      'no duplicate participant row may be created when the same oid signs in with differently-cased email',
    ).toBe(1);
  });
});
