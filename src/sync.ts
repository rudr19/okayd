// Issue -> proof file sync. The GitHub issue is the source of truth for the
// acceptance criteria; `okproof sync` rewrites .okproof/<issue>.md from it, and
// `okproof sync --check` fails CI when the proof file has drifted.
//
// Which checkboxes count:
//   - "- [ ]", "- [x]", "* [ ]" lines (any indent).
//   - never lines inside fenced code blocks (``` or ~~~).
//   - if the body has a heading named "Acceptance criteria" (any level, an
//     optional trailing colon), ONLY the checkboxes under it count, up to the
//     next heading of the same or a higher level. Otherwise every checkbox does.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseProof, splitStableId } from './proof.js';
import { apiBase } from './github.js';

// Same pattern as src/github.ts (owner/name as GitHub allows them).
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

// Greedy single captures, with trimming done in code: no lazy group next to an
// optional whitespace run, which CodeQL flags as polynomial (js/polynomial-redos).
const ITEM_RE = /^\s*[-*]\s+\[[ xX]\]\s+(\S.*)$/;
/** An ATX heading ("## Title"), parsed without a regex: up to 3 leading spaces, 1-6 hashes, then a space or tab. */
function parseHeading(line: string): [string, string, string] | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const start = i;
  while (line[i] === '#' && i - start < 7) i++;
  const level = i - start;
  if (level < 1 || level > 6 || (line[i] !== ' ' && line[i] !== '\t')) return null;
  return [line, line.slice(start, i), line.slice(i).trim()];
}

const ITEM = {
  exec(line: string): [string, string] | null {
    const m = ITEM_RE.exec(line);
    return m ? [m[0], m[1]!.trimEnd()] : null;
  },
};

/** Drops an ATX heading's optional closing hashes ("## Title ##") without a regex. */
function headingText(raw: string): string {
  let s = raw.trimEnd();
  let end = s.length;
  while (end > 0 && s[end - 1] === '#') end--;
  if (end < s.length && (end === 0 || s[end - 1] === ' ' || s[end - 1] === '\t')) s = s.slice(0, end).trimEnd();
  return s;
}

const HEADING = {
  exec(line: string): [string, string, string] | null {
    const m = parseHeading(line);
    return m ? [m[0], m[1], headingText(m[2])] : null;
  },
};
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const AC_HEADING = /^(?:\*\*|__)?acceptance criteria:?(?:\*\*|__)?:?$/i;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Lines of `body` that are outside fenced code blocks, with their text. */
function* outsideFences(body: string): Generator<string> {
  let fence: { ch: string; len: number } | undefined;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = { ch: f[1][0], len: f[1].length };
      continue;
    }
    yield line;
  }
}

/** The criteria text in an issue body, in order. See the header for the rules. */
export function issueCriteria(body: string): string[] {
  const all: string[] = [];
  const scoped: string[] = [];
  let hasSection = false;
  let sectionLevel = 0; // 0 = not inside the section
  for (const line of outsideFences(body)) {
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (AC_HEADING.test(h[2].trim())) {
        hasSection = true;
        sectionLevel = level;
      } else if (sectionLevel && level <= sectionLevel) {
        sectionLevel = 0;
      }
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const text = norm(item[1]);
      all.push(text);
      if (sectionLevel) scoped.push(text);
    }
  }
  return hasSection ? scoped : all;
}

function assertIssue(issue: number): void {
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error(`Issue must be a positive integer, got ${String(issue)}.`);
}

function cleanTitle(title: string): string {
  return norm(title);
}

interface Item {
  text: string;
  /** Stable id from a `{#id}` prefix; kept so rewriting the file never loses it. */
  stableId?: string;
}

/** Issue checkbox text as items: a `{#id}` the issue itself carries is adopted. */
function items(texts: string[]): Item[] {
  return texts.map((t) => {
    const { id, text } = splitStableId(t);
    return id ? { text: norm(text), stableId: id } : { text };
  });
}

function render(issue: number, title: string, list: Item[]): string {
  const head = `## #${issue}${title ? ` ${title}` : ''}`;
  const out = [head, ...list.map((t) => `- [ ] ${t.stableId ? `{#${t.stableId}} ` : ''}${t.text}`)].join('\n') + '\n';
  parseProof(out); // refuses duplicate or invalid ids before anything is written
  return out;
}

/** Renders a proof file for an issue. Throws if the issue lists no criteria. */
export function proofFromIssue(input: { issue: number; title: string; body: string }): string {
  assertIssue(input.issue);
  const texts = issueCriteria(input.body ?? '');
  if (texts.length === 0) throw new Error(noCriteria(input.issue));
  return render(input.issue, cleanTitle(input.title ?? ''), items(texts));
}

function noCriteria(issue: number): string {
  return `Issue #${issue} has no "- [ ]" checkboxes to use as criteria (outside code blocks, and under an "Acceptance criteria" heading if it has one).`;
}

export interface CriterionRef {
  id: string;
  text: string;
}

export interface SyncResult {
  path: string;
  /** The proof file did not exist. */
  created: boolean;
  /** Criteria or title differ from the issue (the file was, or with write:false would be, rewritten). */
  changed: boolean;
  added: CriterionRef[];
  removed: CriterionRef[];
  /** Criteria kept as-is, with their ids after the sync. */
  unchanged: CriterionRef[];
  /** Kept criteria whose id changed because an earlier one was removed: tests tagged with `from` must be re-tagged `to`. */
  renumbered: Array<{ text: string; from: string; to: string }>;
  titleChanged: boolean;
}

export interface SyncOptions {
  dir: string;
  issue: number;
  title: string;
  body: string;
  /** Compute the result without touching the disk. Default true (write). */
  write?: boolean;
  /** The directory `dir` must stay inside. Default process.cwd(). */
  cwd?: string;
}

/**
 * Brings `<dir>/<issue>.md` in line with the issue. Criteria already in the
 * file keep their order (and so their ids); new ones are appended; ones the
 * issue no longer has are dropped. Order changes in the issue alone are not
 * drift. The file is rewritten from the issue, so hand-added notes in it are lost.
 */
export async function syncProofFile(opts: SyncOptions): Promise<SyncResult> {
  assertIssue(opts.issue);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dir = resolve(cwd, opts.dir);
  const rel = relative(cwd, dir);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) {
    throw new Error(`Proof folder ${opts.dir} must be inside the current directory.`);
  }
  const path = join(dir, `${opts.issue}.md`);
  const title = cleanTitle(opts.title ?? '');
  const wantedTexts = issueCriteria(opts.body ?? '');
  if (wantedTexts.length === 0) throw new Error(noCriteria(opts.issue));
  const wanted = items(wantedTexts);

  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const old: Array<{ text: string; index: number; stableId?: string }> = [];
  let oldTitle = '';
  if (existing !== undefined) {
    try {
      const proof = parseProof(existing);
      if (proof.issue !== String(opts.issue)) {
        throw new Error(`${path} describes issue #${proof.issue}, not #${opts.issue}.`);
      }
      oldTitle = norm(proof.title);
      for (const c of proof.criteria) old.push({ text: norm(c.text), index: c.index, stableId: c.stableId });
    } catch (e) {
      // A file with a heading for another issue is a real conflict; an empty or
      // unparseable one is just rewritten.
      if (/describes issue #/.test((e as Error).message)) throw e;
    }
  }

  const free = wanted.map((w) => ({ ...w, used: false }));
  const kept: Array<{ text: string; oldIndex: number; stableId?: string }> = [];
  const removedOld: Array<{ text: string; index: number; stableId?: string }> = [];
  for (const o of old) {
    const hit = free.find((f) => !f.used && f.text === o.text);
    if (hit) {
      hit.used = true;
      kept.push({ text: o.text, oldIndex: o.index, stableId: o.stableId ?? hit.stableId });
    } else removedOld.push(o);
  }
  const added = free.filter((f) => !f.used).map<Item>((f) => ({ text: f.text, ...(f.stableId ? { stableId: f.stableId } : {}) }));

  // A stable id is the id; a positional one is the 1-based position.
  const id = (n: number, stable?: string): string => `${opts.issue}.${stable ?? n}`;
  const finalItems: Item[] = [...kept.map((k) => ({ text: k.text, ...(k.stableId ? { stableId: k.stableId } : {}) })), ...added];
  const result: SyncResult = {
    path,
    created: existing === undefined,
    changed: false,
    unchanged: kept.map((k, i) => ({ id: id(i + 1, k.stableId), text: k.text })),
    added: added.map((a, i) => ({ id: id(kept.length + i + 1, a.stableId), text: a.text })),
    removed: removedOld.map((o) => ({ id: id(o.index, o.stableId), text: o.text })),
    renumbered: kept
      .map((k, i) => ({ text: k.text, from: id(k.oldIndex, k.stableId), to: id(i + 1, k.stableId) }))
      .filter((r) => r.from !== r.to),
    titleChanged: existing !== undefined && oldTitle !== title,
  };
  result.changed = result.created || result.added.length > 0 || result.removed.length > 0 || result.titleChanged;

  if (result.changed && opts.write !== false) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, render(opts.issue, title, finalItems));
  }
  return result;
}

/** Human-readable lines for a sync result (warnings included). */
export function describeSync(issue: number, r: SyncResult, wrote: boolean): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const verb = wrote ? '' : 'would be ';
  if (r.created) lines.push(`#${issue}: proof file ${verb}created at ${r.path} (${r.added.length} criteria)`);
  else if (!r.changed) lines.push(`#${issue}: proof file is in sync (${r.unchanged.length} unchanged)`);
  else lines.push(`#${issue}: proof file ${verb}updated: ${r.added.length} added, ${r.removed.length} removed, ${r.unchanged.length} unchanged${r.titleChanged ? ', title changed' : ''}`);
  for (const a of r.added) lines.push(`  + [okproof:${a.id}] ${a.text}`);
  for (const x of r.removed) lines.push(`  - [okproof:${x.id}] ${x.text}`);
  if (r.renumbered.length > 0) {
    warnings.push(`warning: removing criteria renumbered later ones. Re-tag these tests:`);
    for (const n of r.renumbered) warnings.push(`  [okproof:${n.from}] -> [okproof:${n.to}] ${n.text}`);
  }
  return { lines, warnings };
}

export interface FetchedIssue {
  title: string;
  body: string;
}

export interface FetchIssueOptions {
  repo: string;
  issue: number;
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/** GET /repos/{repo}/issues/{n}. Everything that shapes the URL is validated first. */
export async function fetchIssue(opts: FetchIssueOptions): Promise<FetchedIssue> {
  if (!REPO.test(opts.repo ?? '')) throw new Error(`Repository must look like owner/name, got "${String(opts.repo)}".`);
  assertIssue(opts.issue);
  const api = apiBase(opts.apiUrl);
  if (!api) throw new Error('GITHUB_API_URL must be an https URL.');
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await (opts.fetchImpl ?? fetch)(`${api}/repos/${opts.repo}/issues/${opts.issue}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    throw new Error(`Issue #${opts.issue} not found in ${opts.repo} (or the token cannot see that repository).`);
  }
  if (res.status === 401) throw new Error(`GitHub rejected the token (401) reading ${opts.repo}#${opts.issue}.`);
  if (res.status === 403) {
    throw new Error(`GitHub refused access (403) to ${opts.repo}#${opts.issue}: the token lacks permission or the rate limit is exhausted.`);
  }
  if (!res.ok) throw new Error(`Reading ${opts.repo}#${opts.issue} failed (${res.status}).`);
  const data = (await res.json()) as { title?: unknown; body?: unknown; pull_request?: unknown };
  if (data.pull_request) throw new Error(`#${opts.issue} in ${opts.repo} is a pull request, not an issue.`);
  if (typeof data.title !== 'string') throw new Error(`Unexpected response reading ${opts.repo}#${opts.issue}.`);
  return { title: data.title, body: typeof data.body === 'string' ? data.body : '' };
}

const CLOSING = /(?<![\w/#-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d{1,9})(?!\d)/gi;

/**
 * Issue numbers a pull request body closes in the same repository
 * ("Closes #12", "fixes: #3", "Resolved #7"), in order, without duplicates.
 * Ignores fenced code, HTML comments (PR templates), and cross-repo
 * references like "Closes other/repo#5". Full issue URLs are not recognised.
 */
export function linkedIssues(prBody: string): number[] {
  // Strip HTML comments until none are left, so nested or overlapping markers
  // can't leave a comment behind (CodeQL js/incomplete-multi-character-sanitization).
  let text = [...outsideFences(prBody ?? '')].join('\n');
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  }
  const out: number[] = [];
  for (const m of text.matchAll(CLOSING)) {
    const n = Number(m[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}
