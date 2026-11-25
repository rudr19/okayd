// Used by action.yml: a pull request that adds or changes a proof file for an
// issue it does not link ("Closes #N") is suspicious. An agent can add an easy
// proof file for an unrelated number and have the gate pass on that alone.
// This lists the PR's changed files through the read-only pull request files API
// and reports changed proof files whose issue is not linked.
//
// Warns loudly; fails when REQUIRE_LINKED_PROOF is "1" (the Action's
// require-linked-proof input, which defaults to require-linked).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { linkedIssues } from '../dist/src/sync.js';

const MAX_PAGES = 30;

/** Proof folder as a repo-relative prefix with no "./" and no trailing slash. */
export function normalizeDir(dir) {
  let d = String(dir || '.okproof').replace(/\\/g, '/');
  while (d.startsWith('./')) d = d.slice(2);
  while (d.endsWith('/')) d = d.slice(0, -1);
  return d;
}

/**
 * Proof files (not removed) among the PR's files whose issue is not in `linked`.
 * @param {{ filename: string, status?: string }[]} files
 * @param {string} dir
 * @param {Array<number|string>} linked
 * @returns {string[]} the offending file names
 */
export function unlinkedProofFiles(files, dir, linked) {
  const prefix = `${normalizeDir(dir)}/`;
  const want = new Set(linked.map(String));
  const out = [];
  for (const f of files) {
    const name = f.filename;
    if (f.status === 'removed' || !name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (rest.includes('/') || !rest.endsWith('.md') || rest.startsWith('ledger-')) continue;
    if (!want.has(rest.slice(0, -'.md'.length))) out.push(name);
  }
  return out.sort();
}

/** Every changed file of a pull request (paginated). `fetchImpl` is injectable for tests. */
export async function listPullFiles({ repo, number, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchImpl(`${apiUrl}/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} listing the pull request's files`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Unexpected response listing the pull request files');
    for (const f of batch) if (typeof f?.filename === 'string') files.push({ filename: f.filename, status: f.status });
    if (batch.length < 100) return files;
  }
  throw new Error(`The pull request changes more than ${MAX_PAGES * 100} files`);
}

/**
 * Decide: returns { offenders, failed, messages }. Pure given the files.
 */
export function judgeProofLinks({ files, dir, linked, require }) {
  const offenders = unlinkedProofFiles(files, dir, linked);
  const messages = offenders.map(
    (f) => `${f} is added or changed by this pull request, but its issue is not linked in the PR body ("Closes #N"). A proof file nobody linked can make the gate pass without proving the work. Link the issue, or drop the file.`,
  );
  return { offenders, failed: require && offenders.length > 0, messages };
}

async function main() {
  const dir = process.env.DIR || '.okproof';
  const require = process.env.OKPROOF_REQUIRE_LINKED_PROOF === '1';
  let event;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'));
  } catch {
    console.log('Not a pull request event: skipping the linked-proof check.');
    return 0;
  }
  const pr = event?.pull_request;
  if (!pr || typeof pr.number !== 'number') {
    console.log('Not a pull request event: skipping the linked-proof check.');
    return 0;
  }
  const explicit = (process.env.ISSUE || '').trim().replace(/^#/, '');
  const linked = explicit ? [explicit] : linkedIssues(typeof pr.body === 'string' ? pr.body : '');
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log('::warning::okproof: no token or repository, so the linked-proof check could not list the pull request files.');
    return 0;
  }
  let files;
  try {
    files = await listPullFiles({ repo, number: pr.number, token, apiUrl: process.env.GITHUB_API_URL || undefined });
  } catch (e) {
    console.log(`::warning::okproof: could not verify that changed proof files are linked: ${e.message}`);
    return 0;
  }
  const r = judgeProofLinks({ files, dir, linked, require });
  for (const m of r.messages) console.log(`::${r.failed ? 'error' : 'warning'}::okproof: ${m}`);
  return r.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
