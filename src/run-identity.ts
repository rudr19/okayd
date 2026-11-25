// Which run wrote a ledger: commit, CI run id and time.
import { spawnSync } from 'node:child_process';
import type { Ledger } from './ledger.js';

/** Identity of the run writing a ledger. The commit comes from GITHUB_SHA, else `git rev-parse HEAD` (absent outside a repository). */
export function runIdentity(): NonNullable<Ledger['run']> {
  let commit = /^[0-9a-f]{7,64}$/i.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : undefined;
  if (!commit) {
    try {
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && /^[0-9a-f]{7,64}$/i.test(r.stdout.trim())) commit = r.stdout.trim();
    } catch {
      /* no git */
    }
  }
  const run_id = /^\d{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : undefined;
  return { ...(commit ? { commit } : {}), ...(run_id ? { run_id } : {}), at: new Date().toISOString() };
}
