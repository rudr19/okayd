// Revert check: if you can undo every changed source file and a criterion's
// tests stay green, those tests never exercised the change. For each changed
// source file (or group of files) we revert it to the base inside a temporary
// worktree at HEAD, re-run the tests, and record which criteria flip from pass
// to fail. Zero tokens: no model is involved.
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseProof, type ProofFile } from './proof.js';
import { criteriaHash } from './verify/ledger.js';
import {
  changedFiles,
  currentTestFiles,
  git,
  isSourceFile,
  lastLines,
  overlay,
  repoRoot,
  realOrResolved,
  resolveRevisions,
  resultsRelative,
  runTests,
  withWorktree,
  type Change,
} from './worktree.js';
import { sideRecord } from './differential.js';
import type { RevertCriterion, RevertFile, RevertRun, SideState } from './techniques.js';
import type { TestOutcome } from './ledger.js';

export interface RevertOptions {
  test: string;
  results: string;
  format?: string;
  base?: string;
  dir?: string;
  issue?: string;
  allowUncovered?: boolean;
  /** Most per-file (or per-group) revert runs. Default 20. */
  maxRuns?: number;
  timeoutSec?: number;
  cwd?: string;
  log?: (line: string) => void;
}

export interface RevertResult {
  ok: boolean;
  files: string[];
  lines: string[];
  written: RevertFile[];
}

export interface Group {
  label: string;
  files: Change[];
}

/**
 * One group per file while there are at most `max` files. Beyond that, files
 * are grouped by directory, as deep as still fits in `max` groups, and finally
 * all in one.
 */
export function groupFiles(files: Change[], max: number): Group[] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const limit = Math.max(1, max);
  if (sorted.length <= limit) return sorted.map((f) => ({ label: f.path, files: [f] }));
  const dirs = sorted.map((f) => f.path.split('/').slice(0, -1));
  const deepest = Math.max(...dirs.map((d) => d.length));
  for (let depth = deepest; depth >= 0; depth--) {
    const groups = new Map<string, Change[]>();
    sorted.forEach((f, i) => {
      const key = dirs[i]!.slice(0, depth).join('/');
      const list = groups.get(key);
      if (list) list.push(f);
      else groups.set(key, [f]);
    });
    if (groups.size <= limit || depth === 0) {
      return [...groups.entries()].map(([key, list]) => ({
        label: list.length === 1 ? list[0]!.path : `${key === '' ? '(repository root)' : `${key}/`} (${list.length} files)`,
        files: list,
      }));
    }
  }
  return [];
}

const LITERAL = '--literal-pathspecs';

async function revertFile(tree: string, baseSha: string, f: Change): Promise<void> {
  if (f.status === 'A') await rm(join(tree, f.path), { force: true });
  else git([LITERAL, 'checkout', baseSha, '--', f.path], tree);
}

async function restoreFile(tree: string, headSha: string, f: Change): Promise<void> {
  if (f.status === 'D') await rm(join(tree, f.path), { force: true });
  else git([LITERAL, 'checkout', headSha, '--', f.path], tree);
}

async function proofsIn(dir: string, issue: string | undefined): Promise<ProofFile[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('ledger-') && (!issue || n === `${issue}.md`)).sort();
  } catch {
    /* reported below */
  }
  const out: ProofFile[] = [];
  for (const n of names) out.push(parseProof(await readFile(join(dir, n), 'utf8')));
  if (out.length === 0) throw new Error(`No proof files${issue ? ` for issue #${issue}` : ''} in ${dir}.`);
  return out;
}

export async function runRevertCheck(opts: RevertOptions): Promise<RevertResult> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? (() => undefined);
  const lines: string[] = [];
  const say = (l: string): void => {
    lines.push(l);
    log(l);
  };
  const root = repoRoot(cwd);
  const dirAbs = resolve(cwd, opts.dir ?? '.okproof');
  const proofDirRel = relative(realOrResolved(root), realOrResolved(dirAbs)).replace(/\\/g, '/');
  if (proofDirRel.startsWith('..')) throw new Error(`The proof folder ${dirAbs} is outside the repository.`);
  const proofs = await proofsIn(dirAbs, opts.issue?.replace(/^#/, ''));
  const resultsRel = resultsRelative(root, cwd, opts.results);
  const rev = resolveRevisions(root, opts.base);
  const maxRuns = Math.max(1, Math.floor(opts.maxRuns ?? 20));
  const timeoutMs = Math.max(1, opts.timeoutSec ?? 600) * 1000;
  const tests = currentTestFiles(root, rev.baseSha);
  const sources = changedFiles(root, rev.baseSha, rev.headSha).filter((c) => isSourceFile(c.path));
  say(`okproof revert-check: base ${rev.baseRef} (merge base ${rev.baseSha.slice(0, 12)}) vs HEAD ${rev.headSha.slice(0, 12)}; ${sources.length} changed source file(s)`);

  const groups = groupFiles(sources, maxRuns);
  if (groups.length < sources.length) say(`note: ${sources.length} files grouped into ${groups.length} runs (--max-runs ${maxRuns}); coverage is reported per group.`);

  const runs: RevertRun[] = [];
  const perCriterion = new Map<string, Set<string>>();
  const stateOf = (outcomes: TestOutcome[]): Map<string, SideState> => {
    const m = new Map<string, SideState>();
    for (const proof of proofs) for (const c of proof.criteria) m.set(c.id, sideRecord(outcomes, c.id).state);
    return m;
  };

  const headState = await withWorktree(root, rev.headSha, async (tree) => {
    await overlay(root, tree, proofDirRel, tests);
    const baseline = await runTests(tree, opts.test, resultsRel, 'head', timeoutMs, opts.format);
    if (baseline.outcomes === undefined) {
      throw new Error(`Unreverted HEAD run ${baseline.problem}.${baseline.run.outputTail ? `\nLast output:\n${lastLines(baseline.run.outputTail)}` : ''}`);
    }
    const state = stateOf(baseline.outcomes);
    const passing = [...state.entries()].filter(([, s]) => s === 'pass').map(([id]) => id);

    const runReverted = async (label: string, fileList: Change[], watch: string[]): Promise<void> => {
      const done: Change[] = [];
      let r;
      try {
        for (const f of fileList) {
          await revertFile(tree, rev.baseSha, f);
          done.push(f);
        }
        r = await runTests(tree, opts.test, resultsRel, 'reverted', timeoutMs, opts.format);
      } finally {
        for (const f of done) await restoreFile(tree, rev.headSha, f).catch(() => undefined);
      }
      if (r.run.timedOut) throw new Error(`Revert run for ${label}: ${r.problem}. Raise --timeout.`);
      const now = r.outcomes === undefined ? undefined : stateOf(r.outcomes);
      const flipped = watch.filter((id) => now === undefined || now.get(id) !== 'pass');
      runs.push({ label, files: fileList.map((f) => f.path), flipped, resultsMissing: r.outcomes === undefined });
      for (const id of flipped) {
        const set = perCriterion.get(id) ?? new Set<string>();
        set.add(label);
        perCriterion.set(id, set);
      }
      say(`  revert ${label}: ${flipped.length === 0 ? 'no criterion flipped' : `flipped ${flipped.join(', ')}`}${r.outcomes === undefined ? ` (the run wrote no results: ${r.problem})` : ''}`);
    };

    if (passing.length > 0 && sources.length > 0) {
      for (const g of groups) await runReverted(g.label, g.files, passing);
      const stillGreen = passing.filter((id) => !perCriterion.has(id));
      // A criterion can depend on two files together: try everything reverted at once.
      if (groups.length > 1 && stillGreen.length > 0) {
        await runReverted('(all changed source files together)', sources, stillGreen);
      }
    }
    return state;
  });

  const written: RevertFile[] = [];
  const files: string[] = [];
  let ok = true;
  for (const proof of proofs) {
    const criteria: RevertCriterion[] = proof.criteria.map((c) => {
      const s = headState.get(c.id);
      const covered = [...(perCriterion.get(c.id) ?? [])];
      // Untested, or not passing at HEAD: there is nothing to flip.
      if (s !== 'pass') return { id: c.id, status: s === 'fail' ? 'failing' : 'untested', allowed: false, coveredBy: [] };
      if (covered.length > 0) return { id: c.id, status: 'covered', allowed: false, coveredBy: covered };
      return {
        id: c.id,
        status: 'uncovered',
        allowed: opts.allowUncovered === true,
        coveredBy: [],
        reason: sources.length === 0 ? 'no source files changed, so there is nothing for the tests to exercise' : 'tests stay green with every changed source file reverted',
      };
    });
    const file: RevertFile = {
      version: 1,
      issue: proof.issue,
      baseRef: rev.baseRef,
      base: rev.baseSha,
      head: rev.headSha,
      criteriaHash: criteriaHash(proof),
      allowUncovered: opts.allowUncovered === true,
      maxRuns,
      changedSourceFiles: sources.map((s) => s.path),
      runs,
      criteria,
    };
    const path = join(dirAbs, `revert-${proof.issue}.json`);
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    written.push(file);
    files.push(path);
    say(`#${proof.issue} ${proof.title}`);
    for (const c of criteria) {
      say(`  ${c.id}  ${c.status}${c.allowed ? ' (allowed)' : ''}${c.coveredBy.length > 0 ? `  - covered by ${c.coveredBy.join(', ')}` : c.reason ? `  - ${c.reason}` : ''}`);
      if (c.status === 'uncovered' && !c.allowed) ok = false;
    }
  }
  return { ok, files, lines, written };
}
