// Publishes ledgers on GitHub: always to the job summary, and as one pull
// request comment that is updated in place on reruns.
import { appendFile, readFile } from 'node:fs/promises';
import { renderLedgerMarkdown, type Ledger } from './ledger.js';

/** Hidden marker a rerun uses to find and update its own comment. */
export const COMMENT_MARKER = '<!-- okayd-ledger -->';

export interface GitHubEnv {
  GITHUB_ACTIONS?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_EVENT_PATH?: string;
  GITHUB_REF?: string;
  GITHUB_STEP_SUMMARY?: string;
  GITHUB_API_URL?: string;
  GITHUB_TOKEN?: string;
  GH_TOKEN?: string;
}

export interface PublishResult {
  summary: boolean;
  comment: 'created' | 'updated' | 'skipped';
  reason?: string;
}

export function renderComment(ledgers: Ledger[]): string {
  const proven = ledgers.every((l) => l.proven);
  const head = proven
    ? '## Okayd: every criterion proven'
    : '## Okayd: not proven yet';
  return [COMMENT_MARKER, head, '', ...ledgers.map(renderLedgerMarkdown)].join('\n');
}

/** The pull request number from the event payload, or from refs/pull/N/merge. */
export async function pullRequestNumber(env: GitHubEnv): Promise<number | undefined> {
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
      const n = event?.pull_request?.number ?? event?.issue?.number;
      if (typeof n === 'number') return n;
    } catch {
      // Fall through to the ref.
    }
  }
  const m = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  return m ? Number(m[1]) : undefined;
}

export async function publishToGitHub(
  ledgers: Ledger[],
  env: GitHubEnv = process.env as GitHubEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (env.GITHUB_ACTIONS !== 'true') {
    return { summary: false, comment: 'skipped', reason: 'not running in GitHub Actions' };
  }
  const body = renderComment(ledgers);

  let summary = false;
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, body.replace(COMMENT_MARKER + '\n', '') + '\n');
    summary = true;
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) return { summary, comment: 'skipped', reason: 'no GITHUB_TOKEN' };
  if (!env.GITHUB_REPOSITORY) return { summary, comment: 'skipped', reason: 'no GITHUB_REPOSITORY' };
  const pr = await pullRequestNumber(env);
  if (!pr) return { summary, comment: 'skipped', reason: 'not a pull request' };

  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const base = `${api}/repos/${env.GITHUB_REPOSITORY}/issues`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };

  const list = await fetchImpl(`${base}/${pr}/comments?per_page=100`, { headers });
  if (!list.ok) return { summary, comment: 'skipped', reason: `listing comments failed (${list.status})` };
  const comments = (await list.json()) as Array<{ id: number; body?: string }>;
  const mine = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));

  const res = mine
    ? await fetchImpl(`${base}/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
    : await fetchImpl(`${base}/${pr}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
  if (!res.ok) {
    // A fork's pull_request token is read-only: say so instead of failing the run.
    return { summary, comment: 'skipped', reason: `posting the comment failed (${res.status})` };
  }
  return { summary, comment: mine ? 'updated' : 'created' };
}
