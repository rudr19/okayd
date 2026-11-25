// On-disk results of the two zero-token proof techniques, and how the gate and
// the ledger read them. No git and no child processes here: differential.ts and
// revert.ts write these files, this module only reads and judges them.
//
//   .okproof/diff-<issue>.json    okproof diff          (differential proof)
//   .okproof/revert-<issue>.json  okproof revert-check  (revert check)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ledger } from './ledger.js';
import type { ProofFile } from './proof.js';
import { criteriaHash } from './verify/ledger.js';

export type SideState = 'pass' | 'fail' | 'missing';

export interface SideRecord {
  state: SideState;
  tests: { title: string; status: string }[];
}

/**
 * proven-by-change  fails (or is missing) on the base, passes on HEAD
 * not-differential  passes on both: the test does not depend on this change
 * regressed         passes on the base, fails on HEAD
 * failing           fails on both
 * untested          no test claims it on HEAD
 */
export type DiffStatus = 'proven-by-change' | 'not-differential' | 'regressed' | 'failing' | 'untested';

export interface DiffCriterion {
  id: string;
  status: DiffStatus;
  /** True when a not-differential criterion is accepted (the {pre} marker or --allow-preexisting). */
  allowed: boolean;
  reason?: string;
  base: SideRecord;
  head: SideRecord;
}

export interface DiffFile {
  version: 1;
  issue: string;
  baseRef: string;
  /** The merge-base commit the base side was run at. */
  base: string;
  head: string;
  criteriaHash: string;
  allowPreexisting: boolean;
  criteria: DiffCriterion[];
}

/** covered: reverting some changed source file flips it to failing. uncovered: it never does. */
export type RevertStatus = 'covered' | 'uncovered' | 'failing' | 'untested';

export interface RevertCriterion {
  id: string;
  status: RevertStatus;
  allowed: boolean;
  /** Changed files (or directories, when files were grouped) whose reversion made it fail. */
  coveredBy: string[];
  reason?: string;
}

export interface RevertRun {
  label: string;
  files: string[];
  /** Criteria that passed unreverted and did not pass in this run. */
  flipped: string[];
  /** The run wrote no readable results at all (reverting broke the whole run). */
  resultsMissing: boolean;
}

export interface RevertFile {
  version: 1;
  issue: string;
  baseRef: string;
  base: string;
  head: string;
  criteriaHash: string;
  allowUncovered: boolean;
  maxRuns: number;
  changedSourceFiles: string[];
  runs: RevertRun[];
  criteria: RevertCriterion[];
}

/** A criterion line carrying this marker was already true before the PR. */
export const PRE_MARKER = '{pre}';
export const hasPreMarker = (text: string): boolean => text.includes(PRE_MARKER);

export interface Allow {
  allowPreexisting?: boolean;
  allowUncovered?: boolean;
}

export interface Finding {
  /** The criterion the finding is about. Absent for a stale or unreadable file. */
  id?: string;
  message: string;
}

async function readJson(dir: string, name: string): Promise<{ value?: unknown; problem?: string }> {
  let source: string;
  try {
    source = await readFile(join(dir, name), 'utf8');
  } catch {
    return {};
  }
  try {
    return { value: JSON.parse(source) as unknown };
  } catch {
    return { problem: `${name} is not valid JSON. Delete it or re-run the command that wrote it.` };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Everything the gate must object to in this proof file's diff and revert results. */
export async function techniqueFindings(dir: string, proof: ProofFile, allow: Allow = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const hash = criteriaHash(proof);
  const text = new Map(proof.criteria.map((c) => [c.id, c.text]));

  const diff = await readJson(dir, `diff-${proof.issue}.json`);
  if (diff.problem) out.push({ message: `#${proof.issue}: ${diff.problem}` });
  else if (isRecord(diff.value)) {
    if (diff.value.criteriaHash !== hash) {
      out.push({ message: `#${proof.issue}: differential results are stale (diff-${proof.issue}.json was written for different criteria). Re-run okproof diff or delete the file.` });
    } else if (Array.isArray(diff.value.criteria)) {
      for (const c of diff.value.criteria as DiffCriterion[]) {
        const label = text.get(c.id);
        if (label === undefined) continue;
        if (c.status === 'regressed') {
          out.push({ id: c.id, message: `#${proof.issue} criterion ${c.id} REGRESSED: its tests passed on the base commit and fail on HEAD. ${label}` });
        } else if (c.status === 'not-differential' && !(c.allowed === true || allow.allowPreexisting === true || hasPreMarker(label))) {
          out.push({
            id: c.id,
            message: `#${proof.issue} criterion ${c.id} is NOT DIFFERENTIAL: its tests pass on the base commit too, so they do not prove this change. Add a test that fails without the change, mark the criterion ${PRE_MARKER} if it was already true before this PR, or pass --allow-preexisting. ${label}`,
          });
        }
      }
    }
  }

  const rev = await readJson(dir, `revert-${proof.issue}.json`);
  if (rev.problem) out.push({ message: `#${proof.issue}: ${rev.problem}` });
  else if (isRecord(rev.value)) {
    if (rev.value.criteriaHash !== hash) {
      out.push({ message: `#${proof.issue}: revert-check results are stale (revert-${proof.issue}.json was written for different criteria). Re-run okproof revert-check or delete the file.` });
    } else if (Array.isArray(rev.value.criteria)) {
      for (const c of rev.value.criteria as RevertCriterion[]) {
        const label = text.get(c.id);
        if (label === undefined) continue;
        if (c.status === 'uncovered' && !(c.allowed === true || allow.allowUncovered === true)) {
          out.push({
            id: c.id,
            message: `#${proof.issue} criterion ${c.id} is UNCOVERED: its tests stay green when every changed source file is reverted, so they do not exercise this change. Pass --allow-uncovered only if that is expected. ${label}`,
          });
        }
      }
    }
  }
  return out;
}

/** Marks every criterion the diff or revert results object to as failed in the ledger. */
export async function applyTechniques(ledger: Ledger, dir: string, proof: ProofFile): Promise<Ledger> {
  for (const f of await techniqueFindings(dir, proof)) {
    if (f.id === undefined) continue;
    const entry = ledger.entries.find((e) => e.id === f.id);
    if (!entry || entry.verdict === 'failed') continue;
    entry.verdict = 'failed';
    entry.tests.push({ title: `proof technique [okproof:${entry.id}]`, status: 'failed', evidence: f.message.replace(/\s+/g, ' ').slice(0, 300) });
  }
  ledger.proven = ledger.entries.every((e) => e.verdict === 'met');
  return ledger;
}
