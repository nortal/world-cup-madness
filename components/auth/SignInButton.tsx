'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';

/**
 * Sign-in surface for the public landing page (FR-001 / FR-A1).
 *
 * Initiates the Microsoft Entra OAuth flow via Supabase Auth's `azure`
 * provider. The redirect target is computed at click time from
 * `window.location.origin` so the same component works for both local dev
 * (`http://localhost:3000`) and Vercel deployments.
 *
 * Tenant eligibility is enforced server-side after the OAuth callback
 * (see /auth/callback + provisioning RPC); this component only kicks off
 * the flow. Errors at this stage are OAuth-initiation failures (e.g. the
 * Supabase client failed to reach Auth), not eligibility rejections.
 */
export default function SignInButton() {
  const t = useTranslations('signIn');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleClick() {
    setIsLoading(true);
    setErrorMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: 'openid email profile',
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      // Constitution §1.3: no silent failures. Surface the error to the user
      // and re-enable the button so they can retry.
      console.error('OAuth initiation failed', error);
      setErrorMessage(t('error'));
      setIsLoading(false);
      return;
    }

    // On success the browser is being redirected by Supabase; keep the
    // button disabled until that navigation completes.
  }

  const label = isLoading ? t('loading') : t('label');

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={isLoading}
        aria-label={label}
        className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
      >
        {label}
      </button>
      {errorMessage !== null && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
