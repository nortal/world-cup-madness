import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * next-intl 4.x defaults to looking up the request config at
 * `./i18n/request.{ts,js}` or `./src/i18n/request.{ts,js}`. Our request config
 * lives at `./lib/i18n/config.ts` (T028) — pass the explicit path so the
 * plugin wires `next-intl/config` to the correct module via webpack/turbopack
 * aliasing.
 */
const withNextIntl = createNextIntlPlugin('./lib/i18n/config.ts');

const nextConfig: NextConfig = {};

export default withNextIntl(nextConfig);
