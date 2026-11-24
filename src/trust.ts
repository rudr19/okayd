// Trust: what the merge gate may and may not believe.
//
// A ledger on disk is only a claim that some test run produced it. Anyone who
// can commit can write a ledger by hand, so the gate can rebuild ledgers in
// memory from this job's test results (`okproof gate --results`) and ignore
// whatever is committed. This file also holds the checks that stop a proof file
// from being renamed or swapped for a different issue's.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCTRF } from './ctrf.js';
import { evaluateGate } from './gate.js';
import { buildLedger, type Ledger, type TestOutcome } from './ledger.js';
import { parseJUnit } from './junit.js';
import { lintOutcomes } from './lint.js';
import { parseProof } from './proof.js';
import { applyVerifyFile, readVerifyFile } from './verify/ledger.js';

export type ResultsFormat = 'junit' | 'ctrf';

/** What `--lint [path]` asks for: test files to scan, and whether unrelated tests fail. */
export interface LintRequest {
  /** Path or glob limiting the scan. Absent: every test file under the working directory. */
  tests?: string;
  strictRelevance?: boolean;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Parses a results file; the format is guessed from the extension and first character unless given. */
export function parseResults(text: string, file: string, format?: string): TestOutcome[] {
  if (format !== undefined && format !== 'junit' && format !== 'ctrf') throw new Error(`Unknown --format "${format}". Use junit or ctrf.`);
  const kind = format ?? (file.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{') ? 'ctrf' : 'junit');
  return kind === 'ctrf' ? parseCTRF(text) : parseJUnit(text);
}

async function proofNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('ledger-')).sort();
  } catch {
    return [];
  }
}

/**
 * Builds every ledger from the proof files and one results file, in memory.
 * Nothing is read from, or written to, a committed ledger.
 */
export async function ledgersFromResults(
  dir: string,
  resultsFile: string,
  opts: { format?: string; strictAssertions?: boolean; lint?: LintRequest; report?: (line: string) => void } = {},
): Promise<Ledger[]> {
  const text = await readFile(resultsFile, 'utf8');
  let outcomes = parseResults(text, resultsFile, opts.format);
  if (opts.lint) {
    const l = await lintOutcomes(outcomes, { dir: '.', tests: opts.lint.tests, proofDir: dir, strictRelevance: opts.lint.strictRelevance });
    outcomes = l.outcomes;
    for (const line of l.lines) opts.report?.(line);
    if (!l.ok) throw new Error('okproof lint: a tagged test is possibly unrelated to its criterion (--strict-relevance).');
  }
  const results_sha256 = sha256Hex(text);
  const ledgers: Ledger[] = [];
  for (const name of await proofNames(dir)) {
    const source = await readFile(join(dir, name), 'utf8');
    let proof;
    try {
      proof = parseProof(source);
    } catch {
      continue; // evaluateGate reports the unparseable file
    }
    let ledger: Ledger = { ...buildLedger(proof, outcomes, { strictAssertions: opts.strictAssertions }), results_sha256, proof_sha256: sha256Hex(source) };
    // A confirmed verifier refutation can only make a criterion fail, never pass.
    const verified = await readVerifyFile(dir, ledger.issue);
    if (verified) ledger = applyVerifyFile(ledger, verified);
    ledgers.push(ledger);
  }
  return ledgers;
}

/** A proof file must be named for the issue its heading names, or it can stand in for another issue. */
export async function proofNameProblems(dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const name of await proofNames(dir)) {
    let issue: string;
    try {
      issue = parseProof(await readFile(join(dir, name), 'utf8')).issue;
    } catch {
      continue;
    }
    const stem = name.slice(0, -'.md'.length);
    if (stem !== issue) problems.push(`${name}: heading says #${issue} but the file is named for #${stem}. Rename the file or fix the heading.`);
  }
  return problems;
}

/** Parses "142,143" (or "#142, #143") into issue numbers as strings. Throws on anything else. */
export function parseIssueList(list: string): string[] {
  const out: string[] = [];
  for (const part of list.split(',')) {
    const p = part.trim().replace(/^#/, '');
    if (p === '') continue;
    if (!/^[1-9]\d{0,8}$/.test(p)) throw new Error(`--require-issues takes issue numbers like 142,143, got "${part.trim()}".`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** One problem for each required issue that has no proof file named for it. */
export async function requiredIssueProblems(dir: string, issues: string[]): Promise<string[]> {
  const have = new Set((await proofNames(dir)).map((n) => n.slice(0, -'.md'.length)));
  return issues
    .filter((n) => !have.has(n))
    .map((n) => `#${n} is linked by the pull request but there is no proof file ${join(dir, `${n}.md`).replace(/\\/g, '/')}. Add one (okproof sync --issue ${n}, or sync: write in the Action); renaming another issue's proof file does not count.`);
}

/** Why the committed ledgers cannot be trusted as evidence of a test run in this job. */
export async function unboundLedgerWarnings(dir: string): Promise<string[]> {
  const lines = [
    `warning: ledger is not bound to a test run in this job. The gate is trusting ${dir}/ledger-*.json as committed, and anyone who can commit can hand-write one. Pass --results <junit.xml|ctrf.json> to rebuild the ledgers from this job's own test results.`,
  ];
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.startsWith('ledger-') && n.endsWith('.json'));
  } catch {
    /* no folder */
  }
  for (const n of names.sort()) {
    try {
      const l = JSON.parse(await readFile(join(dir, n), 'utf8')) as Ledger;
      if (!l.results_sha256) lines.push(`warning: ${n} records no results_sha256, so it was not written by okproof ingest.`);
    } catch {
      /* evaluateGate reports invalid JSON */
    }
  }
  return lines;
}

export interface GateArgs {
  dir: string;
  results?: string;
  requireIssues: string[];
  allowEmpty: boolean;
}

/** Parses the arguments after `okproof gate`. `--format` is handled by the caller. */
export function parseGateArgs(list: string[]): GateArgs {
  const out: GateArgs = { dir: '.okproof', requireIssues: [], allowEmpty: false };
  let dirSet = false;
  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a === '--allow-empty') out.allowEmpty = true;
    else if (a === '--results') out.results = need(a, list[++i]);
    else if (a.startsWith('--results=')) out.results = a.slice('--results='.length);
    else if (a === '--require-issues') out.requireIssues.push(...parseIssueList(need(a, list[++i])));
    else if (a.startsWith('--require-issues=')) out.requireIssues.push(...parseIssueList(a.slice('--require-issues='.length)));
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a} for okproof gate.`);
    else if (!dirSet) {
      out.dir = a;
      dirSet = true;
    }
  }
  return out;
}

/** `okproof gate`: returns the exit code. */
export async function runGate(list: string[], opts: { format?: string; strictAssertions?: boolean; lint?: LintRequest }): Promise<number> {
  let a: GateArgs;
  try {
    a = parseGateArgs(list);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (opts.lint && a.results === undefined) {
    console.error('--lint needs --results: lint marks tests from a test run, and there is no run to mark.');
    return 2;
  }
  let ledgers: Ledger[] | undefined;
  if (a.results !== undefined) {
    try {
      ledgers = await ledgersFromResults(a.dir, a.results, { ...opts, report: (l) => console.log(l) });
    } catch (e) {
      console.error(`Could not read test results from ${a.results}: ${(e as Error).message}`);
      return 2;
    }
  }
  const result = await evaluateGate(a.dir, { allowEmpty: a.allowEmpty, ledgers });
  const extra = [...(await proofNameProblems(a.dir)), ...(await requiredIssueProblems(a.dir, a.requireIssues))];
  for (const n of result.notes) console.log(n);
  if (a.results === undefined) for (const w of await unboundLedgerWarnings(a.dir)) console.error(w);
  for (const p of [...result.problems, ...extra]) console.error(p);
  return result.ok && extra.length === 0 ? 0 : 1;
}
