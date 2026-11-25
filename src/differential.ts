// Differential proof: a test that passes before the change and after it proves
// nothing about the change. Run the PR's tests against the base code and against
// HEAD, and keep only the criteria whose tests actually depend on the change.
// Zero tokens: no model is involved.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { claimedCriteria, parseProof, type ProofFile } from './proof.js';
import type { TestOutcome } from './ledger.js';
import { criteriaHash } from './verify/ledger.js';
import {
  currentTestFiles,
  lastLines,
  overlay,
  repoRoot,
  resolveRevisions,
  resultsRelative,
  runTests,
  uncommittedSourceFiles,
  withWorktree,
  type SideRun,
} from './worktree.js';
import { hasPreMarker, type DiffCriterion, type DiffFile, type DiffStatus, type SideRecord } from './techniques.js';

export interface DiffOptions {
  /** Test command, run through the shell in each checkout. */
  test: string;
  /** Results file the command writes, relative to the repository root. */
  results: string;
  format?: string;
  base?: string;
  /** Proof folder. Default ".okproof". */
  dir?: string;
  issue?: string;
  allowPreexisting?: boolean;
  /** Seconds each side may run. Default 600. */
  timeoutSec?: number;
  cwd?: string;
  log?: (line: string) => void;
}

export interface DiffResult {
  /** False when some criterion is not-differential (and not allowed), regressed or failing. */
  ok: boolean;
  files: string[];
  lines: string[];
  written: DiffFile[];
}

export function sideRecord(outcomes: TestOutcome[] | undefined, id: string): SideRecord {
  const tests = (outcomes ?? []).filter((o) => claimedCriteria(o.title).includes(id));
  const state = tests.length === 0 ? 'missing' : tests.every((t) => t.status === 'passed') ? 'pass' : 'fail';
  return { state, tests: tests.map((t) => ({ title: t.title, status: t.status })) };
}

/** Pure: turns the two sides' test outcomes into one record per criterion. */
export function classify(proof: ProofFile, base: TestOutcome[] | undefined, head: TestOutcome[], allowPreexisting = false): DiffCriterion[] {
  return proof.criteria.map((c) => {
    const b = sideRecord(base, c.id);
    const h = sideRecord(head, c.id);
    let status: DiffStatus;
    if (h.state === 'missing') status = 'untested';
    else if (h.state === 'pass') status = b.state === 'pass' ? 'not-differential' : 'proven-by-change';
    else status = b.state === 'pass' ? 'regressed' : 'failing';
    const pre = hasPreMarker(c.text);
    const allowed = status === 'not-differential' && (pre || allowPreexisting);
    const reason =
      status === 'not-differential'
        ? pre
          ? 'marked {pre}: already true before this change'
          : allowPreexisting
            ? 'accepted by --allow-preexisting'
            : 'tests pass on the base commit too'
        : status === 'proven-by-change'
          ? b.state === 'missing'
            ? 'tests do not exist on the base commit'
            : 'tests fail on the base commit and pass on HEAD'
          : undefined;
    return { id: c.id, status, allowed, ...(reason ? { reason } : {}), base: b, head: h };
  });
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

const failing = (c: DiffCriterion): boolean => c.status === 'regressed' || c.status === 'failing' || (c.status === 'not-differential' && !c.allowed);

export async function runDifferential(opts: DiffOptions): Promise<DiffResult> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? (() => undefined);
  const lines: string[] = [];
  const say = (l: string): void => {
    lines.push(l);
    log(l);
  };
  const root = repoRoot(cwd);
  const dirAbs = resolve(cwd, opts.dir ?? '.okproof');
  const proofDirRel = relative(root, dirAbs).replace(/\\/g, '/');
  if (proofDirRel.startsWith('..')) throw new Error(`The proof folder ${dirAbs} is outside the repository.`);
  const proofs = await proofsIn(dirAbs, opts.issue?.replace(/^#/, ''));
  const resultsRel = resultsRelative(root, cwd, opts.results);
  const rev = resolveRevisions(root, opts.base);
  const timeoutMs = Math.max(1, opts.timeoutSec ?? 600) * 1000;
  const tests = currentTestFiles(root, rev.baseSha);

  const dirty = uncommittedSourceFiles(root);
  if (dirty.length > 0) say(`note: ${dirty.length} source file(s) have uncommitted changes; only committed code at HEAD is tested (the current test files and proof files are used as they are on disk).`);
  say(`okproof diff: base ${rev.baseRef} (merge base ${rev.baseSha.slice(0, 12)}) vs HEAD ${rev.headSha.slice(0, 12)}; ${tests.length} changed test file(s) carried onto the base`);

  const runSide = (side: 'base' | 'head', sha: string): Promise<SideRun> =>
    withWorktree(root, sha, async (tree) => {
      await overlay(root, tree, proofDirRel, tests);
      return runTests(tree, opts.test, resultsRel, side, timeoutMs, opts.format);
    });

  const base = await runSide('base', rev.baseSha);
  if (base.run.timedOut) throw new Error(`Base run: ${base.problem}. Raise --timeout; a timeout proves nothing either way.`);
  if (base.outcomes === undefined) say(`warning: base run ${base.problem}. Every tagged test counts as missing on the base. ${lastLines(base.run.outputTail, 4)}`);
  const head = await runSide('head', rev.headSha);
  if (head.outcomes === undefined) {
    throw new Error(`HEAD run ${head.problem}.${head.run.outputTail ? `\nLast output:\n${lastLines(head.run.outputTail)}` : ''}`);
  }

  const written: DiffFile[] = [];
  const files: string[] = [];
  let ok = true;
  for (const proof of proofs) {
    const criteria = classify(proof, base.outcomes, head.outcomes, opts.allowPreexisting === true);
    const file: DiffFile = {
      version: 1,
      issue: proof.issue,
      baseRef: rev.baseRef,
      base: rev.baseSha,
      head: rev.headSha,
      criteriaHash: criteriaHash(proof),
      allowPreexisting: opts.allowPreexisting === true,
      criteria,
    };
    const path = join(dirAbs, `diff-${proof.issue}.json`);
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    written.push(file);
    files.push(path);
    say(`#${proof.issue} ${proof.title}`);
    for (const c of criteria) {
      say(`  ${c.id}  ${c.status}${c.allowed ? ' (allowed)' : ''}${c.reason ? `  - ${c.reason}` : ''}`);
      if (failing(c)) ok = false;
    }
  }
  return { ok, files, lines, written };
}
