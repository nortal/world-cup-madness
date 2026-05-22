#!/usr/bin/env node
/**
 * Regenerator for `lib/matches/iana-timezones.ts`.
 *
 * Reads the local Node runtime's IANA zone list via
 * `Intl.supportedValuesOf('timeZone')`, sorts alphabetically, and rewrites
 * the static TS module that backs the `<TimezonePicker/>` combobox on
 * `/profile` (feature 002 / FR-M15, research.md §R-2).
 *
 * Idempotent: running twice in a row with no IANA db change produces no diff.
 *
 * Manual command:
 *   node scripts/regen-iana-timezones.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PATH = path.resolve(
  __dirname,
  '..',
  'lib',
  'matches',
  'iana-timezones.ts',
);

// `Intl.supportedValuesOf('timeZone')` omits the fixed-offset `'UTC'` alias on
// some Node versions but the renderer-side fallback in `day-bucket.ts` and
// elsewhere relies on UTC being a selectable picker value. Append + dedupe +
// re-sort so the list is stable across runtimes.
const zones = Array.from(
  new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']),
).sort();

const nodeVersion = process.version;

const body = `\nexport const IANA_TIMEZONES: readonly string[] = [\n${zones
  .map((z) => `  '${z}',`)
  .join('\n')}\n];\n`;

// Idempotency: reuse the existing header (which carries the regen timestamp)
// when the zone list + Node version are unchanged. This keeps `node
// scripts/regen-iana-timezones.mjs` a no-op when the IANA db hasn't moved.
const existing = await readFile(OUTPUT_PATH, 'utf8').catch(() => null);
const existingHeaderMatch = existing?.match(
  /^\/\*\*[\s\S]*?Last regenerated against: Node (v\d+\.\d+\.\d+), ([^\n]+?)\n[\s\S]*?\*\/\n/,
);
const existingBody = existing?.slice(existingHeaderMatch?.[0].length ?? 0);
const sameContent =
  existingBody === body && existingHeaderMatch?.[1] === nodeVersion;

const timestamp = sameContent
  ? (existingHeaderMatch?.[2] ?? new Date().toISOString())
  : new Date().toISOString();

const header = `/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate by running:  node scripts/regen-iana-timezones.mjs
 * Last regenerated against: Node ${nodeVersion}, ${timestamp}
 *
 * Source: Intl.supportedValuesOf('timeZone') from the local Node runtime at
 * the time of regeneration. This list drives the <TimezonePicker/> combobox
 * on /profile (feature 002 / FR-M15). Keeping it static + frozen means the
 * picker doesn't need to call Intl.supportedValuesOf per render, and we
 * don't ship runtime-dependent picker contents.
 *
 * Refresh policy: regenerate annually or when a new IANA zone is added that
 * a participant requests. Adding zones is backwards-compatible; removing
 * them is breaking (the renderer-side UTC fallback covers stored values not
 * in this list — see spec.md §3 edge cases).
 */
`;

await writeFile(OUTPUT_PATH, header + body, 'utf8');

const today = timestamp.slice(0, 10);
console.log(
  `Regenerated lib/matches/iana-timezones.ts with ${zones.length} zones (Node ${nodeVersion}, ${today})`,
);
