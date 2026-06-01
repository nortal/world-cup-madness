import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * `/privacy` page (US7 / T067 — FR-A10, TC-11).
 *
 * Public, informational privacy notice describing what participant data the
 * World Cup Madness platform collects, why, who can see it, the legal basis,
 * and the retention period. Linked from the landing page, the access-denied
 * page, and the first-login welcome modal via the shared `<PrivacyLink />`
 * component (US7 / T068).
 *
 * Server Component — no `'use client'`, no client-side state, no interactive
 * widgets beyond the back-link to `/`. Lock / eligibility / auth status are
 * irrelevant here (constitution §IV.1 Frontend) because this route is PUBLIC.
 *
 * PUBLIC route — NO auth gate:
 *   - Per FR-A10 / TC-11 ("The `/privacy` route MUST be accessible without
 *     authentication"), anyone can hit `/privacy` whether or not they hold a
 *     valid Supabase session. We deliberately do NOT instantiate the Supabase
 *     server client and do NOT call `supabase.auth.getUser()` here. Doing so
 *     would force a per-request auth round-trip for content that contains no
 *     personal data and is identical for every visitor — and would also break
 *     the access path for a rejected user who lands on `/access-denied` and
 *     wants to read the privacy notice before deciding whether to retry.
 *   - There is also no PII on this page (no email, no display name, no oid /
 *     tid), so FR-018 data-minimization concerns do not apply.
 *
 * Content sourcing:
 *   - Every user-visible string comes from the `privacy` translation namespace
 *     (T071 owns the JSON across en / es / pt-BR). No English copy is inlined
 *     in this file. If T071 has not landed yet at runtime, the keys will
 *     render as their key paths in dev — that is the documented next-intl
 *     fallback and is acceptable for parallel execution.
 *   - The retention paragraph (`privacy.retentionBody`) is a PLACEHOLDER
 *     pending a Privacy / Legal-set retention value — see spec.md line 170.
 *     The placeholder lives in the translation JSON, not here; this file only
 *     references the key.
 *
 * Semantic structure (FR-A10 / TC-11 accessibility requirements):
 *   - Single `<h1>` for the page title.
 *   - Five `<section>` blocks, one per topic (data collected, purpose,
 *     audience, legal basis, retention). Each section uses an `<h2>` with a
 *     stable `id`, and the parent `<section>` carries `aria-labelledby`
 *     pointing at that id so assistive tech announces the section's purpose.
 *   - No skipped heading levels: only h1 then h2.
 *   - The back-link uses `next/link` and a self-explanatory label (e.g.
 *     "Back to sign-in") so it makes sense out of context — no "click here".
 *
 * Translation namespace: `privacy` (see `lib/i18n/messages/{en,es,pt-BR}.json`).
 * Keys consumed by this page: `heading`, `intro`, `dataCollectedHeading`,
 * `dataCollectedBody`, `purposeHeading`, `purposeBody`, `audienceHeading`,
 * `audienceBody`, `legalBasisHeading`, `legalBasisBody`, `retentionHeading`,
 * `retentionBody`, `backLabel`. The remaining `privacy.*` keys
 * (`linkLabel`, `welcomeSummary`, `learnMore`) are consumed by sibling tasks
 * (T068 / T070) and are not referenced here.
 */
export default async function PrivacyPage() {
  const t = await getTranslations('privacy');

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-base text-gray-700">{t('intro')}</p>
      </header>

      <section className="mt-8" aria-labelledby="privacy-data-collected">
        <h2 id="privacy-data-collected" className="text-xl font-semibold tracking-tight">
          {t('dataCollectedHeading')}
        </h2>
        <p className="mt-2 text-base text-gray-700">{t('dataCollectedBody')}</p>
      </section>

      <section className="mt-8" aria-labelledby="privacy-purpose">
        <h2 id="privacy-purpose" className="text-xl font-semibold tracking-tight">
          {t('purposeHeading')}
        </h2>
        <p className="mt-2 text-base text-gray-700">{t('purposeBody')}</p>
      </section>

      <section className="mt-8" aria-labelledby="privacy-audience">
        <h2 id="privacy-audience" className="text-xl font-semibold tracking-tight">
          {t('audienceHeading')}
        </h2>
        <p className="mt-2 text-base text-gray-700">{t('audienceBody')}</p>
      </section>

      <section className="mt-8" aria-labelledby="privacy-legal-basis">
        <h2 id="privacy-legal-basis" className="text-xl font-semibold tracking-tight">
          {t('legalBasisHeading')}
        </h2>
        <p className="mt-2 text-base text-gray-700">{t('legalBasisBody')}</p>
      </section>

      {/* Retention paragraph is a PLACEHOLDER pending a Privacy / Legal-set
          retention value — see spec.md line 170. The placeholder copy lives
          in the translation JSON owned by T071, not here. */}
      <section className="mt-8" aria-labelledby="privacy-retention">
        <h2 id="privacy-retention" className="text-xl font-semibold tracking-tight">
          {t('retentionHeading')}
        </h2>
        <p className="mt-2 text-base text-gray-700">{t('retentionBody')}</p>
      </section>

      <nav className="mt-12">
        <Link href="/" className="text-base text-blue-600 underline hover:text-blue-700">
          {t('backLabel')}
        </Link>
      </nav>
    </main>
  );
}
