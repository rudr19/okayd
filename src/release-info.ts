// What this build knows about itself: its exact version, and (for a published release) the
// full commit it was built from. `okproof init` uses both to write pinned references.
//
// RELEASE_COMMIT is a placeholder in the repository. The release workflow replaces it with
// the commit being released (scripts/stamp-release.mjs) before it builds and packs, so only
// the published package knows its commit. Anything that is not a 40-character hex digest is
// treated as "unknown" and init falls back to the mutable `v0` tag, with a comment saying
// to pin.
import { readFileSync } from 'node:fs';

export const RELEASE_COMMIT = '__OKPROOF_RELEASE_COMMIT__';

const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The package's version, read from the package.json that ships next to dist/. */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) throw new Error('okproof package.json has no valid version.');
  return pkg.version;
}

/** The stamped release commit, or undefined while the placeholder is still in place (any non-SHA value). */
export function releaseCommit(raw: string = RELEASE_COMMIT): string | undefined {
  return SHA.test(raw) ? raw : undefined;
}

export interface ActionRef {
  /** Value for a workflow `uses:` key, without the key. */
  uses: string;
  /** YAML comment lines (each starts with "#") to put above the step; empty when the ref is pinned. */
  comments: string[];
  pinned: boolean;
}

/** How a generated workflow should reference the okproof Action. Pure: tests pass the inputs. */
export function okproofActionRef(opts: { commit?: string; version?: string } = {}): ActionRef {
  const commit = opts.commit !== undefined ? releaseCommit(opts.commit) : releaseCommit();
  const version = opts.version ?? packageVersion();
  if (commit !== undefined) return { uses: `rudr19/okproof@${commit} # v${version}`, comments: [], pinned: true };
  return {
    uses: 'rudr19/okproof@v0',
    comments: [
      '# Tags can be moved. Pin this to a full commit SHA, for example:',
      `#   uses: rudr19/okproof@<full commit sha of the release> # v${version}`,
      '# (the release page and the tag list show each release commit).',
    ],
    pinned: false,
  };
}

/** The exact-version npx invocation init writes into agent files, e.g. "npx okproof@0.3.0". */
export function pinnedNpx(version: string = packageVersion()): string {
  return `npx okproof@${version}`;
}
