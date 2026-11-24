// Publishes ledgers on GitHub: always to the job summary, and as one pull
// request comment that is updated in place on reruns.
import { appendFile, readFile } from 'node:fs/promises';
import { renderLedgerMarkdown, type Ledger } from './ledger.js';
import type { GateResult } from './gate.js';

/** Hidden marker a rerun uses to find and update its own comment. */
export const COMMENT_MARKER = '<!-- okproof-ledger -->';

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

/**
 * The headline comes from the gate result when given (the proof files are the
 * source of truth, so a stale ledger is never "proven"). Without one it is
 * recomputed from the entries, never read from `ledger.proven`.
 */
export function renderComment(ledgers: Ledger[], gate?: Pick<GateResult, 'ok' | 'problems'>): string {
  const proven = gate ? gate.ok : ledgers.every((l) => l.entries.length > 0 && l.entries.every((e) => e.verdict === 'met'));
  const head = proven
    ? '## okproof: every criterion proven'
    : '## okproof: not proven yet';
  const why = gate && !gate.ok && gate.problems.length ? ['', ...gate.problems.map((p) => `- ${p}`)] : [];
  const unproven = ledgers.flatMap((l) => l.entries.filter((e) => e.verdict === 'unproven').map((e) => `#${l.issue} ${e.id}`));
  const note = unproven.length
    ? ['', `Silence is not proof: ${unproven.join(', ')} only passed tests that made no assertions. Add a real assertion to each tagged test.`]
    : [];
  return [COMMENT_MARKER, head, ...why, ...note, '', ...ledgers.map(renderLedgerMarkdown)].join('\n');
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

/** owner/name as GitHub allows them. */
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** GitHub rejects comments over 65,536 characters; stay under it. */
export const MAX_COMMENT_CHARS = 60_000;

export function capBody(body: string): string {
  if (body.length <= MAX_COMMENT_CHARS) return body;
  return body.slice(0, MAX_COMMENT_CHARS) + '\n\n_Ledger truncated. See the job summary or `.okproof/ledger-*.md` for the full table._\n';
}

/** The API origin: https only, no credentials, query or fragment. */
export function apiBase(raw: string | undefined): string | undefined {
  try {
    const url = new URL(raw || 'https://api.github.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Up to this many pages of 100 comments are searched for our marker. */
const MAX_PAGES = 10;

export async function publishToGitHub(
  ledgers: Ledger[],
  env: GitHubEnv = process.env as GitHubEnv,
  fetchImpl: typeof fetch = fetch,
  gate?: Pick<GateResult, 'ok' | 'problems'>,
): Promise<PublishResult> {
  if (env.GITHUB_ACTIONS !== 'true') {
    return { summary: false, comment: 'skipped', reason: 'not running in GitHub Actions' };
  }
  const body = capBody(renderComment(ledgers, gate));

  let summary = false;
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      await appendFile(env.GITHUB_STEP_SUMMARY, body.replace(COMMENT_MARKER + '\n', '') + '\n');
      summary = true;
    } catch (e) {
      return { summary, comment: 'skipped', reason: `writing the job summary failed (${(e as Error).message})` };
    }
  }

  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) return { summary, comment: 'skipped', reason: 'no GITHUB_TOKEN' };

  // Everything that shapes the request URL is validated, so values read from
  // the environment or the event file can't redirect it.
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!REPO.test(repo)) return { summary, comment: 'skipped', reason: 'invalid or missing GITHUB_REPOSITORY' };
  const pr = await pullRequestNumber(env);
  if (!pr) return { summary, comment: 'skipped', reason: 'not a pull request' };
  const api = apiBase(env.GITHUB_API_URL);
  if (!api) return { summary, comment: 'skipped', reason: 'GITHUB_API_URL must be an https URL' };
  const base = `${api}/repos/${repo}/issues`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
  };

  // A network failure must not fail the run: the ledger is already written.
  try {
    let mine: { id: number } | undefined;
    for (let page = 1; page <= MAX_PAGES && !mine; page++) {
      const list = await fetchImpl(`${base}/${pr}/comments?per_page=100&page=${page}`, { headers });
      if (!list.ok) return { summary, comment: 'skipped', reason: `listing comments failed (${list.status})` };
      const comments = (await list.json()) as Array<{ id: number; body?: string }>;
      mine = comments.find((c) => Number.isSafeInteger(c.id) && c.id > 0 && c.body?.startsWith(COMMENT_MARKER));
      if (comments.length < 100) break;
    }

    const res = mine
      ? await fetchImpl(`${base}/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
      : await fetchImpl(`${base}/${pr}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
    if (!res.ok) {
      // A fork's pull_request token is read-only: say so instead of failing the run.
      return { summary, comment: 'skipped', reason: `posting the comment failed (${res.status})` };
    }
    return { summary, comment: mine ? 'updated' : 'created' };
  } catch (e) {
    return { summary, comment: 'skipped', reason: `GitHub request failed (${(e as Error).message})` };
  }
}
