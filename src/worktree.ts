// Git and process plumbing shared by `okproof diff` and `okproof revert-check`.
//
// Everything runs in a temporary git worktree outside the repository. The
// caller's working tree, index, branches and config are never touched: the only
// repository state we create is the worktree's own metadata, and it is removed
// (and pruned) in a finally block.
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { parseCTRF } from './ctrf.js';
import { parseJUnit } from './junit.js';
import type { TestOutcome } from './ledger.js';

/** Runs git with an argument array (never a shell). Throws with git's own message on failure. */
export function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error) throw new Error(`Could not run git: ${r.error.message}`);
  if (r.status !== 0) {
    const sub = args.find((a) => !a.startsWith('-')) ?? 'git';
    throw new Error(`git ${sub} failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`);
  }
  return r.stdout;
}

export function gitAvailable(): boolean {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

export function repoRoot(cwd: string): string {
  return resolve(git(['rev-parse', '--show-toplevel'], cwd).trim());
}

export interface Revisions {
  baseRef: string;
  /** merge-base of the base ref and HEAD: what the base side is run at. */
  baseSha: string;
  headSha: string;
}

const isSha = (s: string): boolean => /^[0-9a-f]{40,64}$/.test(s);

/** Resolves the base ref (default origin/main, falling back to main) to its merge-base with HEAD. */
export function resolveRevisions(root: string, ref: string | undefined): Revisions {
  const candidates = ref === undefined ? ['origin/main', 'main'] : [ref];
  let baseRef = '';
  let refSha = '';
  for (const c of candidates) {
    if (c === '' || c.startsWith('-') || c.includes('\0')) throw new Error(`Invalid --base "${c}".`);
    const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], { cwd: root, encoding: 'utf8' });
    const out = r.stdout.trim();
    if (r.status === 0 && isSha(out)) {
      baseRef = c;
      refSha = out;
      break;
    }
  }
  if (!refSha) {
    throw new Error(`Cannot resolve base ref ${ref === undefined ? '"origin/main" (or "main")' : `"${ref}"`}. Pass --base <ref>; in CI check out with fetch-depth: 0 so the base branch is available.`);
  }
  const headSha = git(['rev-parse', 'HEAD'], root).trim();
  const mb = spawnSync('git', ['merge-base', refSha, headSha], { cwd: root, encoding: 'utf8' });
  const baseSha = mb.stdout.trim();
  if (mb.status !== 0 || !isSha(baseSha)) {
    throw new Error(`No merge base between ${baseRef} and HEAD. In CI check out with fetch-depth: 0 (a shallow clone cannot find it).`);
  }
  if (baseSha === headSha) throw new Error(`HEAD has no commits beyond ${baseRef} (merge base is HEAD itself), so there is no change to prove.`);
  return { baseRef, baseSha, headSha };
}

// ---------------------------------------------------------------- file kinds

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__', '__fixtures__', 'fixtures', 'testdata', 'cypress']);
const TEST_SUFFIXES = ['.test', '.spec', '_test', '_spec', '-test', '-spec'];

/** Plain string checks, no regular expressions. */
export function isTestFile(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  for (const d of parts.slice(0, -1)) if (TEST_DIRS.has(d.toLowerCase())) return true;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const lower = stem.toLowerCase();
  if (lower === 'test' || lower === 'spec' || lower === 'conftest') return true;
  if (lower.startsWith('test_') || lower.startsWith('test-')) return true;
  if (TEST_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return stem.endsWith('Test') || stem.endsWith('Tests');
}

const DOC_DIRS = new Set(['docs', 'doc', '.github', '.okproof']);
const DOC_EXT = new Set(['md', 'mdx', 'rst', 'adoc', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'pdf']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json', 'cargo.lock', 'go.sum', 'poetry.lock', 'gemfile.lock', 'composer.lock', 'pipfile.lock', 'uv.lock']);
const DOC_NAMES = ['license', 'notice', 'changelog', 'readme', 'codeowners'];

/** A changed file that can change behaviour: not a test, proof file, doc, asset or lockfile. */
export function isSourceFile(path: string): boolean {
  if (isTestFile(path)) return false;
  const parts = path.split('/');
  for (const d of parts.slice(0, -1)) if (DOC_DIRS.has(d.toLowerCase())) return false;
  const name = (parts[parts.length - 1] ?? '').toLowerCase();
  if (LOCKFILES.has(name) || name.endsWith('.lock')) return false;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && DOC_EXT.has(name.slice(dot + 1))) return false;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return !DOC_NAMES.includes(stem);
}

export interface Change {
  /** A (added at HEAD), D (deleted at HEAD) or M (anything else). */
  status: 'A' | 'D' | 'M';
  path: string;
}

/** Files that differ between two commits, with no rename detection. */
export function changedFiles(root: string, from: string, to: string): Change[] {
  const parts = git(['diff', '-z', '--name-status', '--no-renames', from, to], root).split('\0');
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i]!;
    const p = parts[i + 1]!;
    if (s === '' || p === '') continue;
    out.push({ status: s[0] === 'A' ? 'A' : s[0] === 'D' ? 'D' : 'M', path: p });
  }
  return out;
}

/** Test files that differ from the base in the working tree (committed, staged, unstaged or untracked). */
export function currentTestFiles(root: string, baseSha: string): string[] {
  const changed = git(['diff', '-z', '--name-only', '--no-renames', baseSha], root).split('\0');
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], root).split('\0');
  return [...new Set([...changed, ...untracked].filter((p) => p !== '' && isTestFile(p)))].sort();
}

/** Tracked source files with uncommitted changes (they are not part of what HEAD proves). */
export function uncommittedSourceFiles(root: string): string[] {
  return git(['diff', '-z', '--name-only', 'HEAD'], root).split('\0').filter((p) => p !== '' && isSourceFile(p));
}

// ----------------------------------------------------------------- worktrees

async function dropLink(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    await unlink(path);
  } catch {
    await rmdir(path); // a Windows junction
  }
}

/**
 * Checks out `sha` in a temporary detached worktree, calls `fn`, then always
 * removes the worktree. The repository's node_modules is linked in (not copied)
 * so the test command can find its dependencies.
 */
export async function withWorktree<T>(root: string, sha: string, fn: (tree: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), 'okproof-wt-'));
  const tree = join(tmp, 'tree');
  try {
    git(['worktree', 'add', '--detach', tree, sha], root);
    const modules = join(root, 'node_modules');
    try {
      await lstat(modules);
      await lstat(join(tree, 'node_modules')).then(
        () => undefined,
        () => symlink(modules, join(tree, 'node_modules'), 'junction'),
      );
    } catch {
      /* no node_modules to link */
    }
    return await fn(tree);
  } finally {
    // Unlink first so nothing below can follow the link into the real node_modules.
    await dropLink(join(tree, 'node_modules')).catch(() => undefined);
    try {
      git(['worktree', 'remove', '--force', tree], root);
    } catch {
      /* the directory removal below still runs */
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    try {
      git(['worktree', 'prune'], root);
    } catch {
      /* nothing to prune */
    }
  }
}

/** Puts the current proof folder and test files into a worktree, so only the code differs between sides. */
export async function overlay(root: string, tree: string, proofDirRel: string, tests: string[]): Promise<void> {
  if (proofDirRel !== '' && proofDirRel !== '.') {
    const src = join(root, proofDirRel);
    const dst = join(tree, proofDirRel);
    await rm(dst, { recursive: true, force: true });
    try {
      await readdir(src);
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst, { recursive: true });
    } catch {
      /* no proof folder in the working tree */
    }
  }
  for (const rel of tests) {
    try {
      await mkdir(dirname(join(tree, rel)), { recursive: true });
      await copyFile(join(root, rel), join(tree, rel));
    } catch {
      /* deleted in the working tree */
    }
  }
}

/** The results path relative to the repository root. Throws if it points outside. */
export function resultsRelative(root: string, cwd: string, results: string): string {
  const rel = normalize(relative(root, resolve(cwd, results)));
  if (rel === '' || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\')) {
    throw new Error(`--results "${results}" must be a file inside the repository, because each side writes it in its own checkout.`);
  }
  return rel;
}

// ---------------------------------------------------------------- test runs

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
}

function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return fallback();
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

/**
 * Runs the user's own test command through the shell. `command` is the user's
 * text and is passed whole; okproof-controlled values travel only through the
 * environment (OKPROOF_SIDE), never inside the command string.
 */
export function runShell(command: string, cwd: string, side: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, OKPROOF_SIDE: side },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let tail = '';
    const keep = (b: Buffer): void => {
      tail = (tail + b.toString('utf8')).slice(-4000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ exitCode: code, timedOut, outputTail: tail });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill('SIGKILL'));
      setTimeout(() => finish(null), 5000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(e);
      }
    });
    child.on('close', (code) => finish(code));
  });
}

/** Parses a results file; JUnit unless the format says CTRF (or the file looks like JSON). */
export function parseOutcomes(text: string, file: string, format: string | undefined): TestOutcome[] {
  const kind = format ?? (file.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{') ? 'ctrf' : 'junit');
  return kind === 'ctrf' ? parseCTRF(text) : parseJUnit(text);
}

export interface SideRun {
  run: RunResult;
  /** Undefined when the command wrote no readable results file. */
  outcomes?: TestOutcome[];
  problem?: string;
}

/** Deletes any old results file, runs the command in `tree`, and reads what it wrote. */
export async function runTests(tree: string, command: string, resultsRel: string, side: string, timeoutMs: number, format: string | undefined): Promise<SideRun> {
  const file = join(tree, resultsRel);
  await rm(file, { force: true });
  const run = await runShell(command, tree, side, timeoutMs);
  if (run.timedOut) return { run, problem: `the test command timed out after ${Math.round(timeoutMs / 1000)}s` };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { run, problem: `the test command wrote no results file at ${resultsRel} (exit ${run.exitCode})` };
  }
  try {
    return { run, outcomes: parseOutcomes(text, file, format) };
  } catch (e) {
    return { run, problem: `could not read ${resultsRel}: ${(e as Error).message}` };
  }
}

export const lastLines = (s: string, n = 8): string => s.trimEnd().split(/\r?\n/).slice(-n).join('\n');

/**
 * The real, long-form path (resolves Windows 8.3 short names like RUNNER~1 and
 * symlinks) so "is this inside the repo?" compares like with like. Falls back to
 * the parent's real path for a path that doesn't exist yet.
 */
export function realOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return join(realpathSync.native(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}
