// Evidence levels: how much a criterion's "met" is worth.
//
//   E0 claimed      the criterion exists, nothing else
//   E1 passed       a tagged test passed
//   E2 solid        every tagged test passed cleanly (no flake), at least one made a real,
//                   non-trivial assertion, and lint does not call that test unrelated
//   E3 survived     E2, and it survived adversarial verification: `okproof verify` held for it, or a
//                   diff/revert file marks it proven-by-change or covered
//   E4 attested     E3, produced in CI from this job's own results file (`gate --results`), on a
//                   commit whose .okproof/ folder matches the base branch
//
// A failing tagged test (or a refutation) drops the criterion to E0. The level is
// recorded in the ledger next to the level the proof file requires, and a criterion is
// met only when achieved >= required AND the existing rules hold.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestOutcome } from './ledger.js';
import type { ProofFile } from './proof.js';
import { criteriaHash, readVerifyFile } from './verify/ledger.js';

export type EvidenceLevel = 0 | 1 | 2 | 3 | 4;

export const MAX_LEVEL: EvidenceLevel = 4;
/** Required level when neither the proof line nor --min-level says otherwise. */
export const DEFAULT_MIN_LEVEL: EvidenceLevel = 2;
/** The highest level a ledger read from disk can be credited with: only the gate, from this job's results, can attest E4. */
export const MAX_UNATTESTED_LEVEL: EvidenceLevel = 3;

export const LEVEL_TITLES: Record<EvidenceLevel, string> = {
  0: 'claimed',
  1: 'a tagged test passed',
  2: 'solid tagged test',
  3: 'survived adversarial verification',
  4: 'proven in CI',
};

/** Parses "3" or "E3" (for --min-level). Throws on anything else. */
export function parseLevel(text: string): EvidenceLevel {
  const t = text.trim();
  const digits = t.startsWith('E') ? t.slice(1) : t;
  if (digits.length === 1 && digits >= '0' && digits <= '4') return Number(digits) as EvidenceLevel;
  throw new Error(`Evidence level "${text}" must be one of E0, E1, E2, E3, E4 (or 0 to 4).`);
}

/** A stored level as a valid level, or undefined for anything else (forged or missing). */
export function asLevel(v: unknown): EvidenceLevel | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LEVEL ? (v as EvidenceLevel) : undefined;
}

/** What the proof line requires: its own `{E3}`, else the minimum level. */
export function requiredLevel(criterion: { level?: number }, minLevel: EvidenceLevel = DEFAULT_MIN_LEVEL): EvidenceLevel {
  return asLevel(criterion.level) ?? minLevel;
}

/** "E2/E3 ▰▰▱": achieved, required, and a bar as long as the requirement. */
export function formatLevel(level: number, required: number): string {
  const filled = Math.max(0, Math.min(level, required));
  return `E${level}/E${required}${required > 0 ? ` ${'▰'.repeat(filled)}${'▱'.repeat(required - filled)}` : ''}`;
}

// ------------------------------------------------------------ adversarial

/** What adversarial evidence exists for one criterion. */
export interface Adversarial {
  /** `.okproof/verify-<n>.json` has verdict "held" for it. */
  verified?: boolean;
  /** A diff or revert file marks it proven-by-change or covered. */
  byChange?: boolean;
  /** The verifier ran but did not conclude: the outcome (max-steps, budget, ...). */
  inconclusive?: string;
}

const BY_CHANGE = new Set(['proven-by-change', 'covered']);

function changeEntries(parsed: unknown): Array<[string, string]> {
  if (parsed === null || typeof parsed !== 'object') return [];
  const out: Array<[string, string]> = [];
  // The format okproof diff and okproof revert-check write: {"criteriaHash", "criteria": [{"id", "status"}]}.
  // It must carry a criteriaHash, which readAdversarial checks against the proof file.
  const written = (parsed as { criteria?: unknown; criteriaHash?: unknown });
  if (Array.isArray(written.criteria) && typeof written.criteriaHash === 'string') {
    for (const r of written.criteria) {
      if (r === null || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.status === 'string') out.push([o.id, o.status]);
    }
  }
  const results = (parsed as { results?: unknown }).results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r === null || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      const id = o.criterionId ?? o.id;
      const status = o.verdict ?? o.status;
      if (typeof id === 'string' && typeof status === 'string') out.push([id, status]);
    }
  } else if (results !== null && typeof results === 'object') {
    for (const [id, status] of Object.entries(results as Record<string, unknown>)) {
      if (typeof status === 'string') out.push([id, status]);
    }
  }
  return out;
}

/**
 * Reads the optional adversarial files for one proof file:
 *   verify-<n>.json  written by okproof verify; verdict "held" supports E3
 *   diff-<n>.json    {"criteriaHash"?, "results": [{"criterionId", "verdict"}]} (or "results": {"<id>": "<verdict>"});
 *   revert-<n>.json  same shape; the verdicts "proven-by-change" and "covered" support E3
 * A file whose criteriaHash differs from the proof file's is stale and ignored. A missing,
 * unreadable or malformed file simply supplies no evidence (the gate reports a bad verify file itself).
 */
export async function readAdversarial(dir: string, proof: ProofFile): Promise<Map<string, Adversarial>> {
  const map = new Map<string, Adversarial>();
  const entry = (id: string): Adversarial => {
    let a = map.get(id);
    if (!a) map.set(id, (a = {}));
    return a;
  };
  const hash = criteriaHash(proof);
  try {
    const v = await readVerifyFile(dir, proof.issue);
    if (v && v.criteriaHash === hash) {
      for (const r of Array.isArray(v.results) ? v.results : []) {
        if (r.verdict === 'held') entry(r.criterionId).verified = true;
        else if (r.verdict === 'inconclusive') entry(r.criterionId).inconclusive = r.outcome;
      }
    }
  } catch {
    /* evaluateGate reports an invalid verify file */
  }
  for (const kind of ['diff', 'revert']) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, `${kind}-${proof.issue}.json`), 'utf8'));
    } catch {
      continue;
    }
    const stamp = (parsed as { criteriaHash?: unknown } | null)?.criteriaHash;
    if (typeof stamp === 'string' && stamp !== hash) continue;
    for (const [id, status] of changeEntries(parsed)) if (BY_CHANGE.has(status)) entry(id).byChange = true;
  }
  return map;
}

// ---------------------------------------------------------------- grading

/** Where the results came from. Both must hold for E4. */
export interface CiContext {
  /** The ledger was built from a results file read in this job (`gate --results`, or ingest in the Action). */
  resultsBound: boolean;
  /** `.okproof/` is identical to the base branch (the Action passes --proof-matches-base). */
  proofMatchesBase: boolean;
}

export interface EvidenceInput {
  id: string;
  /** The test-derived verdict, before the required level is applied. */
  base: 'met' | 'failed' | 'unproven' | 'untested';
  tests: TestOutcome[];
  /** Titles of passing tests that asserted nothing. */
  weak: string[];
  adversarial?: Adversarial;
  ci?: CiContext;
}

export interface EvidenceGrade {
  level: EvidenceLevel;
  /** gaps[i] says what is missing to reach level + 1 + i (so it is empty at E4). */
  gaps: string[];
}

const list = (titles: string[]): string => titles.map((t) => `"${t}"`).join(', ');

/** What it takes to reach level `k`, given the state of the criterion. */
function gapFor(k: 1 | 2 | 3 | 4, i: EvidenceInput, level: EvidenceLevel): string {
  const passed = i.tests.filter((t) => t.status === 'passed');
  const notPassed = i.tests.filter((t) => t.status !== 'passed');
  if (k === 1) {
    if (i.tests.length === 0) return `add a test whose title carries [okproof:${i.id}] and make it pass`;
    return `make a tagged test pass (${list(notPassed.map((t) => `${t.title}: ${t.status}`))}); a failing test contradicts the criterion`;
  }
  if (k === 2) {
    const parts: string[] = [];
    if (notPassed.length > 0) parts.push(`every tagged test must pass cleanly, not fail, flake or skip: ${list(notPassed.map((t) => t.title))}`);
    if (level < 1 && i.tests.length === 0) parts.push(`add a passing tagged test [okproof:${i.id}] with a real assertion`);
    const weak = passed.filter((t) => i.weak.includes(t.title));
    if (weak.length > 0) parts.push(`add a real, non-trivial assertion to ${list(weak.map((t) => t.title))}`);
    const unrelated = passed.filter((t) => t.unrelatedTo?.includes(i.id) === true && !i.weak.includes(t.title));
    if (unrelated.length > 0) parts.push(`lint says ${list(unrelated.map((t) => t.title))} never mentions what the criterion is about; make the test exercise it`);
    return parts.join('; ') || 'a tagged test must pass cleanly with a real assertion that exercises the criterion';
  }
  if (k === 3) {
    const n = i.id.split('.')[0];
    if (i.adversarial?.inconclusive) return `the verifier ended inconclusive (${i.adversarial.inconclusive}); re-run okproof verify with a larger --max-steps or --budget-tokens until it holds, or add .okproof/diff-${n}.json or revert-${n}.json marking it proven-by-change`;
    return `survive adversarial verification: run okproof verify until it holds for ${i.id}, or add .okproof/diff-${n}.json or revert-${n}.json marking it proven-by-change or covered`;
  }
  if (!i.ci?.resultsBound) return 'produce it in CI: run okproof gate --results <file> --proof-matches-base in the CI job (the GitHub Action does)';
  return 'the .okproof/ folder differs from the base branch; E4 needs it unchanged in the pull request, so land the proof and verifier files first';
}

/** The generic gap for level `k`, used when a stored ledger does not carry its own. */
export function genericGap(k: number, id: string): string {
  const level = Math.min(Math.max(k, 1), 4) as 1 | 2 | 3 | 4;
  return gapFor(level, { id, base: 'untested', tests: [], weak: [] }, 0);
}

/** Grades one criterion. Pure. */
export function gradeEvidence(i: EvidenceInput): EvidenceGrade {
  const passed = i.tests.filter((t) => t.status === 'passed');
  let level: EvidenceLevel = 0;
  if (i.base !== 'failed' && passed.length > 0) level = 1;
  const real = passed.filter((t) => !i.weak.includes(t.title) && t.unrelatedTo?.includes(i.id) !== true);
  if (level >= 1 && i.base === 'met' && real.length > 0) level = 2;
  if (level >= 2 && (i.adversarial?.verified || i.adversarial?.byChange)) level = 3;
  if (level >= 3 && i.ci?.resultsBound && i.ci.proofMatchesBase) level = 4;
  const gaps: string[] = [];
  for (let k = level + 1; k <= MAX_LEVEL; k++) gaps.push(gapFor(k as 1 | 2 | 3 | 4, i, level));
  return { level, gaps };
}

// ------------------------------------------------------------------- gate

/**
 * The level the gate credits an entry with. An entry with no `level` is a ledger from before
 * evidence levels: "met" counts as E2. Levels above E3 are credited only when `trusted`, that
 * is, when the ledger was rebuilt in this job from its results file.
 */
export function effectiveLevel(entry: { verdict?: string; level?: unknown }, trusted: boolean): EvidenceLevel {
  const stored = asLevel(entry.level) ?? (entry.verdict === 'met' || entry.verdict === 'insufficient' ? 2 : 0);
  return trusted ? stored : (Math.min(stored, MAX_UNATTESTED_LEVEL) as EvidenceLevel);
}

/** The sentence a gate or status report gives for a criterion short of its required level. */
export function shortfall(id: string, entry: { level?: unknown; gaps?: unknown; verdict?: string }, level: EvidenceLevel, required: EvidenceLevel): string {
  const stored = asLevel(entry.level) ?? (entry.verdict === 'met' || entry.verdict === 'insufficient' ? 2 : 0);
  const gaps = Array.isArray(entry.gaps) ? entry.gaps.filter((g): g is string => typeof g === 'string') : [];
  const steps: string[] = [];
  for (let k = level + 1; k <= required; k++) steps.push((k > stored ? gaps[k - stored - 1] : undefined) ?? genericGap(k, id));
  return steps.join('; then ');
}
