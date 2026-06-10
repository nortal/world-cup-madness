'use client';

import { useContext } from 'react';
import { useTranslations } from 'next-intl';

import { DashboardRefreshContext } from '@/components/dashboard/DashboardRealtime';

/**
 * `<RefreshingChip/>` — fixed-position status announcer (feature 005
 * US-DD T035 / FR-D15, TC-D16).
 *
 * Reads `isRefetching` from `DashboardRefreshContext` (provided by
 * `<DashboardRealtime/>`) and renders a small `role="status"` chip in
 * the top-right corner while the dashboard's Server Components are
 * being re-fetched.
 *
 * Why fixed-position: the chip is mounted in the page header but must
 * appear ABOVE the widget grid without displacing it (NFR-D02 / FC-D2 —
 * zero CLS during stale-while-revalidate). `fixed` keeps it out of the
 * normal flow.
 *
 * Why `role="status"` (not `role="alert"`): the refresh is an
 * informational, low-urgency announcement — `status` is the polite
 * ARIA live region that SR users hear without losing focus
 * (matches the i18n key naming `dashboard.refreshing`).
 */
export default function RefreshingChip(): React.ReactElement | null {
  const t = useTranslations('dashboard');
  const { isRefetching } = useContext(DashboardRefreshContext);

  if (!isRefetching) return null;

  return (
    <div
      role="status"
      className="fixed top-2 right-2 z-50 rounded-md bg-blue-100 px-3 py-1 text-sm text-blue-800 shadow-md"
    >
      {t('refreshing')}
    </div>
  );
}
