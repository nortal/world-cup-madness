'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * Privacy notice link (FR-A10 / T068).
 *
 * Client Component — `<Link>` to the public `/privacy` route, label from
 * `useTranslations('privacy')`. The Client boundary is required because the
 * component is rendered inside `<WelcomeModal/>` (T070), which is itself a
 * Client Component (focus trap, Esc handler, dismiss RPC). Next.js does not
 * allow importing Server Components into Client Components, so this shared
 * link component must also be Client to be usable in both call sites
 * (landing page footer via T069 + welcome modal via T070).
 *
 * The hydration cost is a single anchor — negligible — and the shared
 * abstraction keeps the privacy-link surface consistent in both placements
 * (same href, same label, only visual variant differs).
 *
 * Two variants are supported via the optional `variant` prop:
 *
 *   - `footer` (default): subtle gray underlined link, label
 *     `privacy.linkLabel` ("Privacy notice"). Used in the landing page
 *     footer (T069) where the link sits among low-key supporting text and
 *     must announce itself clearly to screen readers.
 *   - `inline`: brighter blue underlined link, label `privacy.learnMore`
 *     ("Learn more"). Used inside the welcome modal (T070) where it follows
 *     a one-line privacy summary in body copy. FR-A3 (e) calls for a "Learn
 *     more" wording in that placement, distinct from the standalone
 *     "Privacy notice" affordance.
 *
 * Both variants resolve to the same `href` (`/privacy`); only the label and
 * styling differ. Keeping the component the single source of truth for
 * privacy-link surface means all roads to the privacy page go through one
 * file — any future change to the route or the link styling lands here.
 *
 * Translation namespace: `privacy` (keys: `linkLabel`, `learnMore`).
 */

type PrivacyLinkVariant = 'footer' | 'inline';

type PrivacyLinkProps = {
  variant?: PrivacyLinkVariant;
};

const VARIANT_CLASSES: Record<PrivacyLinkVariant, string> = {
  footer:
    'text-sm text-gray-600 underline hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded',
  inline:
    'text-sm text-blue-700 underline hover:text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded',
};

export default function PrivacyLink({ variant = 'footer' }: PrivacyLinkProps) {
  const t = useTranslations('privacy');
  const label = variant === 'inline' ? t('learnMore') : t('linkLabel');

  return (
    <Link href="/privacy" className={VARIANT_CLASSES[variant]}>
      {label}
    </Link>
  );
}
