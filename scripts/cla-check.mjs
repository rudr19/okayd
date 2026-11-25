// CLA check, run by .github/workflows/cla-check.yml on pull_request with a read-only token.
//
// A first-time contributor must comment the exact sentence below on their pull request
// (CLA.md and CONTRIBUTING.md say the same). This only reads: it lists the PR's comments and
// fails the job, with an error annotation and a job summary, when the author has not signed.
// It cannot comment (that needs a write token, which this job deliberately does not get).
//
// Who is checked: authors GitHub marks NONE, FIRST_TIMER or FIRST_TIME_CONTRIBUTOR. Owners,
// members, collaborators and people with an earlier merged contribution (CONTRIBUTOR) are
// exempt, and so are bots such as Dependabot.
//
// Limit: on a pull_request event the workflow file and this script come from the PR's own
// merge commit, so a hostile PR could edit them. Treat this as a reminder for honest
// contributors, not a control; the maintainer still checks the CLA before merging.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CLA_PHRASE = 'I have read the okproof CLA and I agree to it.';
const CHECKED = new Set(['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR']);

/** Whitespace-trimmed plain string equality. No regular expression, no substring match. */
export function isSignature(body) {
  return typeof body === 'string' && body.trim() === CLA_PHRASE;
}

/**
 * @param {{ author: string, association: string, authorType?: string, comments: Array<{ user?: { login?: string }, body?: string }> }} p
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkCla({ author, association, authorType, comments }) {
  if (authorType === 'Bot' || String(author).endsWith('[bot]')) return { ok: true, reason: `${author} is a bot; no CLA needed.` };
  if (!CHECKED.has(association)) return { ok: true, reason: `${author} is ${association}; no new CLA needed.` };
  const signed = comments.some((c) => c?.user?.login === author && isSignature(c.body));
  if (signed) return { ok: true, reason: `${author} signed the CLA on this pull request.` };
  return { ok: false, reason: `${author} has not signed the CLA. Comment exactly: ${CLA_PHRASE}` };
}

async function listComments(repo, number, token, apiUrl = 'https://api.github.com') {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${apiUrl}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`listing comments failed (${res.status})`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function main(env) {
  const { REPO, PR_NUMBER, PR_AUTHOR, AUTHOR_ASSOCIATION, AUTHOR_TYPE, GITHUB_TOKEN } = env;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(REPO ?? '') || !/^[1-9]\d{0,8}$/.test(PR_NUMBER ?? '') || !PR_AUTHOR) {
    throw new Error('REPO, PR_NUMBER and PR_AUTHOR are required.');
  }
  const comments = CHECKED.has(AUTHOR_ASSOCIATION ?? '') ? await listComments(REPO, PR_NUMBER, GITHUB_TOKEN, env.GITHUB_API_URL || undefined) : [];
  const result = checkCla({ author: PR_AUTHOR, association: AUTHOR_ASSOCIATION ?? '', authorType: AUTHOR_TYPE, comments });
  console.log(result.reason);
  if (!result.ok) {
    console.log(`::error title=CLA not signed::${result.reason}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### CLA not signed\n\n${result.reason}\n\nSee [CLA.md](../blob/main/CLA.md). The maintainer cannot merge this pull request until the sentence is on the PR.\n`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::${e.message}`);
      process.exit(2);
    },
  );
}
