// okproof doctor: read-only checks that the repository actually protects what
// okproof relies on. okproof cannot enforce CODEOWNERS or required reviews; they
// are the real control (docs/trust.md). doctor looks at the working tree and, with
// a repository name, reads branch protection through the GitHub API (GET only; a
// token is optional and is never printed or written anywhere).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { globMatch } from './lint.js';

export type Level = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  level: Level;
  /** Short stable id such as "codeowners". */
  id: string;
  message: string;
}

export interface DoctorOptions {
  /** Repository root. Default ".". */
  cwd?: string;
  /** Proof folder, relative to cwd. Default ".okproof". */
  dir?: string;
  /** owner/name. Without it the GitHub checks are skipped with a warning. */
  repo?: string;
  /** Read-only token (optional; public data needs none, branch protection needs admin read). */
  token?: string;
  /** Required status check name. Default: any check whose name contains "okproof" or "prove". */
  check?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** False when any check failed. */
  ok: boolean;
  lines: string[];
}

const MAX_BYTES = 1_000_000;

async function readText(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > MAX_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pattern matching shared by CODEOWNERS and .gitignore. No regular expression is built from input.

/** Does a CODEOWNERS / .gitignore pattern match `path` (relative, "/" separated)? */
export function patternMatches(pattern: string, path: string): boolean {
  let p = pattern.trim();
  if (p === '') return false;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) anchored = true;
  if (p === '') return false;
  const glob = anchored ? p : `**/${p}`;
  try {
    // A pattern may name the file itself, or a directory above it.
    if (!dirOnly && globMatch(glob, path)) return true;
    return globMatch(`${glob}/**`, path);
  } catch {
    return false;
  }
}

interface Rule {
  pattern: string;
  owners: string[];
}

function codeownersRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const hash = parts.findIndex((x) => x.startsWith('#'));
    const owners = (hash === -1 ? parts.slice(1) : parts.slice(1, hash)).filter((o) => o.startsWith('@') || o.includes('@'));
    rules.push({ pattern: parts[0]!, owners });
  }
  return rules;
}

/** Owners of `path` under CODEOWNERS rules: the last matching rule wins. undefined when no rule matches. */
export function ownersOf(rules: Rule[], path: string): string[] | undefined {
  let hit: Rule | undefined;
  for (const r of rules) if (patternMatches(r.pattern, path)) hit = r;
  return hit?.owners;
}

/** Is `path` ignored under .gitignore text (last match wins, "!" negates)? */
export function isIgnored(gitignore: string, path: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (patternMatches(negate ? line.slice(1) : line, path)) ignored = !negate;
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Local checks

async function checkCodeowners(cwd: string, dir: string, out: DoctorCheck[]): Promise<void> {
  let text: string | undefined;
  let where = '';
  for (const rel of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    text = await readText(join(cwd, rel));
    if (text !== undefined) {
      where = rel;
      break;
    }
  }
  if (text === undefined) {
    out.push({ level: 'fail', id: 'codeowners', message: `No CODEOWNERS file. Add .github/CODEOWNERS with "/${dir}/ @your-team" so criteria cannot change without review.` });
    return;
  }
  const probe = `${dir}/probe.md`;
  const owners = ownersOf(codeownersRules(text), probe);
  if (owners === undefined) out.push({ level: 'fail', id: 'codeowners', message: `${where} has no rule covering ${dir}/. Add "/${dir}/ @your-team".` });
  else if (owners.length === 0) out.push({ level: 'fail', id: 'codeowners', message: `${where}: the rule matching ${dir}/ names no owner, which leaves it unowned.` });
  else out.push({ level: 'pass', id: 'codeowners', message: `${where} covers ${dir}/ (${owners.join(' ')}).` });
}

async function checkGitignore(cwd: string, dir: string, out: DoctorCheck[]): Promise<void> {
  const text = (await readText(join(cwd, '.gitignore'))) ?? '';
  const paths = [`${dir}/ledger-1.json`, `${dir}/ledger-1.md`];
  const missing = paths.filter((p) => !isIgnored(text, p));
  if (missing.length === 0) out.push({ level: 'pass', id: 'gitignore', message: `.gitignore ignores ${dir}/ledger-* (ledgers are rebuilt from test results, never trusted from git).` });
  else out.push({ level: 'warn', id: 'gitignore', message: `.gitignore does not ignore ${missing.map((m) => m.replace('1', '*')).join(', ')}. Committed ledgers can be written by hand; add "${dir}/ledger-*" to .gitignore.` });
}

/** Lines of the `with:` block of the step that starts at `usesLine` (same step only). */
function withBlock(lines: string[], usesLine: number): string[] {
  const indent = (s: string): number => s.length - s.trimStart().length;
  const stepIndent = indent(lines[usesLine]!);
  const block: string[] = [];
  let inWith = false;
  let withIndent = 0;
  for (let i = usesLine + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    const ind = indent(l);
    if (!inWith) {
      // Another step (a "- " at or left of the step key) ends the search.
      if (ind < stepIndent || (ind === stepIndent && l.trimStart().startsWith('- '))) break;
      if (l.trim() === 'with:' || l.trim().startsWith('with:')) {
        inWith = true;
        withIndent = ind;
      }
      continue;
    }
    if (ind <= withIndent) break;
    block.push(l.trim());
  }
  return block;
}

const keyOf = (line: string): string => line.slice(0, line.indexOf(':')).trim();
const valueOf = (line: string): string => line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');

async function checkWorkflows(cwd: string, out: DoctorCheck[]): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(join(cwd, '.github', 'workflows'))).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml')).sort();
  } catch {
    /* none */
  }
  let found = false;
  for (const n of names) {
    const text = await readText(join(cwd, '.github', 'workflows', n));
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const differential = /differential/i.test(text);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim().replace(/^-\s+/, '');
      const usesAction = t.startsWith('uses:') && /okproof@|okproof\/okproof/.test(t);
      if (usesAction) {
        found = true;
        const w = withBlock(lines, i);
        const results = w.find((l) => keyOf(l) === 'results');
        const committed = w.find((l) => keyOf(l) === 'allow-committed-ledgers');
        if (results && valueOf(results) !== '') out.push({ level: 'pass', id: 'workflow', message: `${n}: the okproof Action gets a results input.` });
        else if (committed && valueOf(committed) === 'true') out.push({ level: 'warn', id: 'workflow', message: `${n}: allow-committed-ledgers is true, so the gate trusts ledgers committed to git.` });
        else out.push({ level: 'fail', id: 'workflow', message: `${n}: the okproof Action has no results input; it would trust committed ledgers. Set results: junit.xml (or your CTRF file).` });
        const allowEmpty = w.find((l) => keyOf(l) === 'allow-empty');
        if (allowEmpty && valueOf(allowEmpty) === 'true') out.push({ level: 'pass', id: 'workflow', message: `${n}: allow-empty is on, so the check can run on every pull request.` });
      } else if (/\bokproof\s+gate\b/.test(t) && !t.startsWith('#')) {
        found = true;
        if (/--results\b/.test(t)) out.push({ level: 'pass', id: 'workflow', message: `${n}: okproof gate runs with --results.` });
        else out.push({ level: 'fail', id: 'workflow', message: `${n}: okproof gate runs without --results; it would trust committed ledgers.` });
      }
    }
    if (differential && found) {
      const depth = /fetch-depth:\s*['"]?(\d+)/.exec(text);
      if (depth && (depth[1] === '0' || Number(depth[1]) > 1)) out.push({ level: 'pass', id: 'fetch-depth', message: `${n}: differential checks have history to compare (fetch-depth ${depth[1]}).` });
      else out.push({ level: 'fail', id: 'fetch-depth', message: `${n}: differential checks need git history, but actions/checkout has no fetch-depth: 0 (the default is a single commit).` });
    }
  }
  if (!found) out.push({ level: 'fail', id: 'workflow', message: 'No workflow in .github/workflows runs okproof (uses the Action or runs okproof gate).' });
}

// ---------------------------------------------------------------------------
// GitHub checks (GET only)

interface Api {
  get(path: string): Promise<{ status: number; body: unknown }>;
}

function api(opts: DoctorOptions): Api {
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  return {
    async get(path) {
      const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await f(`${base}${path}`, { method: 'GET', headers });
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, body };
    },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Findings {
  /** Status check names required, or undefined when this source could not say. */
  contexts?: string[];
  /** require_code_owner_reviews, or undefined when unknown. */
  codeOwnerReview?: boolean;
  readable: boolean;
  /** The branch is definitively unprotected by this source. */
  unprotected?: boolean;
}

function fromRulesets(body: unknown): Findings {
  if (!Array.isArray(body)) return { readable: false };
  const contexts: string[] = [];
  let codeOwnerReview = false;
  for (const r of body) {
    if (!isObj(r)) continue;
    const params = isObj(r.parameters) ? r.parameters : {};
    if (r.type === 'required_status_checks' && Array.isArray(params.required_status_checks)) {
      for (const c of params.required_status_checks) if (isObj(c) && typeof c.context === 'string') contexts.push(c.context);
    }
    if (r.type === 'pull_request' && params.require_code_owner_review === true) codeOwnerReview = true;
  }
  return { readable: true, contexts, codeOwnerReview };
}

function fromProtection(status: number, body: unknown): Findings {
  if (status === 200 && isObj(body)) {
    const contexts: string[] = [];
    const rsc = isObj(body.required_status_checks) ? body.required_status_checks : undefined;
    if (rsc) {
      if (Array.isArray(rsc.contexts)) for (const c of rsc.contexts) if (typeof c === 'string') contexts.push(c);
      if (Array.isArray(rsc.checks)) for (const c of rsc.checks) if (isObj(c) && typeof c.context === 'string') contexts.push(c.context);
    }
    const prr = isObj(body.required_pull_request_reviews) ? body.required_pull_request_reviews : undefined;
    return { readable: true, contexts, codeOwnerReview: prr?.require_code_owner_reviews === true };
  }
  if (status === 404 && isObj(body) && body.message === 'Branch not protected') return { readable: true, unprotected: true, contexts: [], codeOwnerReview: false };
  return { readable: false };
}

async function checkGitHub(opts: DoctorOptions, out: DoctorCheck[]): Promise<void> {
  const repo = opts.repo;
  if (!repo) {
    out.push({ level: 'warn', id: 'github', message: 'No repository given (--repo owner/name), so branch protection was not checked.' });
    return;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    out.push({ level: 'fail', id: 'github', message: `--repo must look like owner/name, got "${repo}".` });
    return;
  }
  const a = api(opts);
  let branch: string;
  try {
    const r = await a.get(`/repos/${repo}`);
    if (r.status !== 200 || !isObj(r.body) || typeof r.body.default_branch !== 'string') {
      out.push({ level: 'warn', id: 'github', message: `Could not read ${repo} (HTTP ${r.status}); branch protection was not checked. ${opts.token ? '' : 'A token may be needed for a private repository.'}`.trim() });
      return;
    }
    branch = r.body.default_branch;
  } catch (e) {
    out.push({ level: 'warn', id: 'github', message: `Could not reach GitHub (${(e as Error).message}); branch protection was not checked.` });
    return;
  }
  if (!/^[\w./-]+$/.test(branch)) {
    out.push({ level: 'warn', id: 'github', message: 'The default branch name is unusual; branch protection was not checked.' });
    return;
  }
  const enc = branch.split('/').map(encodeURIComponent).join('/');
  const sources: Findings[] = [];
  try {
    const rs = await a.get(`/repos/${repo}/rules/branches/${enc}`);
    sources.push(rs.status === 200 ? fromRulesets(rs.body) : { readable: false });
    const bp = await a.get(`/repos/${repo}/branches/${enc}/protection`);
    sources.push(fromProtection(bp.status, bp.body));
  } catch (e) {
    out.push({ level: 'warn', id: 'github', message: `Could not read branch protection (${(e as Error).message}).` });
    return;
  }
  const readable = sources.filter((s) => s.readable);
  const wanted = (c: string): boolean => (opts.check ? c === opts.check || c.endsWith(` / ${opts.check}`) : /okproof|prove/i.test(c));
  const contexts = readable.flatMap((s) => s.contexts ?? []);
  const required = contexts.filter(wanted);
  const reviewed = readable.some((s) => s.codeOwnerReview === true);
  const allReadable = readable.length === sources.length;
  const nothingKnown = readable.length === 0;

  if (required.length > 0) out.push({ level: 'pass', id: 'required-check', message: `${branch} requires the status check "${required[0]}".` });
  else if (nothingKnown) out.push({ level: 'warn', id: 'required-check', message: `Could not read protection for ${branch} (no token, or it lacks admin read). Check by hand that the okproof job is a required status check.` });
  else if (!allReadable) out.push({ level: 'warn', id: 'required-check', message: `No ruleset on ${branch} requires an okproof check, and classic branch protection could not be read (needs a token with admin read). Check by hand.` });
  else out.push({ level: 'fail', id: 'required-check', message: `${branch} does not require the okproof check${opts.check ? ` "${opts.check}"` : ''}. Add it as a required status check (branch protection or a ruleset).` });

  if (reviewed) out.push({ level: 'pass', id: 'codeowner-review', message: `${branch} requires code-owner review.` });
  else if (nothingKnown) out.push({ level: 'warn', id: 'codeowner-review', message: `Could not read protection for ${branch}. Check by hand that code-owner review is required; without it CODEOWNERS does not protect ${opts.dir ?? '.okproof'}/.` });
  else if (!allReadable) out.push({ level: 'warn', id: 'codeowner-review', message: `No ruleset on ${branch} requires code-owner review, and classic branch protection could not be read. Check by hand.` });
  else out.push({ level: 'fail', id: 'codeowner-review', message: `${branch} does not require code-owner review, so CODEOWNERS is advisory. Turn on "Require review from Code Owners".` });
}

// ---------------------------------------------------------------------------

/** Parses owner/name out of a git remote URL without keeping credentials. */
export function repoFromRemote(url: string): string | undefined {
  let s = url.trim();
  const scp = /^[\w.-]+@[\w.-]+:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(s);
  if (scp) return scp[1];
  const at = s.indexOf('://');
  if (at !== -1) {
    s = s.slice(at + 3);
    const slash = s.indexOf('/');
    if (slash === -1) return undefined;
    const host = s.slice(0, slash);
    if (!host.endsWith('github.com')) return undefined;
    const path = s.slice(slash + 1).replace(/\.git$/, '').replace(/\/+$/, '');
    return /^[\w.-]+\/[\w.-]+$/.test(path) ? path : undefined;
  }
  return undefined;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const cwd = options.cwd ?? '.';
  const dir = (options.dir ?? '.okproof').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const checks: DoctorCheck[] = [];
  await checkCodeowners(cwd, dir, checks);
  await checkGitignore(cwd, dir, checks);
  await checkWorkflows(cwd, checks);
  await checkGitHub({ ...options, dir }, checks);
  const lines = checks.map((c) => `${c.level.toUpperCase().padEnd(4)}  ${c.message}`);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(`okproof doctor: ${checks.length - fails - warns} passed, ${warns} warning${warns === 1 ? '' : 's'}, ${fails} failed`);
  return { checks, ok: fails === 0, lines };
}
