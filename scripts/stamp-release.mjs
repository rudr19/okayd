// Release workflow step: writes the commit being released into src/release-info.ts, before
// `npm test` builds and `npm pack` packs, so the published package can print
// `uses: rudr19/okproof@<full sha> # vX.Y.Z` from `okproof init --workflow`.
// Usage: RELEASE_SHA=<40 hex> node scripts/stamp-release.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PLACEHOLDER = '__OKPROOF_RELEASE_COMMIT__';

/** Returns `text` with the placeholder replaced. Throws on a bad SHA or when the placeholder is missing. */
export function stamp(text, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('RELEASE_SHA must be a full 40-character lowercase hex commit id.');
  const first = text.indexOf(PLACEHOLDER);
  if (first < 0) throw new Error('src/release-info.ts has no release placeholder to stamp (already stamped?).');
  return text.slice(0, first) + sha + text.slice(first + PLACEHOLDER.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = new URL('../src/release-info.ts', import.meta.url);
  try {
    writeFileSync(file, stamp(readFileSync(file, 'utf8'), process.env.RELEASE_SHA));
    console.log('Stamped release commit.');
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
