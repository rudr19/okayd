import { claimedCriteria, type ProofFile } from './proof.js';
import { DEFAULT_MIN_LEVEL, formatLevel, gradeEvidence, requiredLevel, type Adversarial, type CiContext, type EvidenceLevel } from './evidence.js';

/**
 * met       every claiming test passed and at least one made a real assertion
 * failed    a claiming test failed, was flaky, skipped, timed out, ...
 * unproven  claiming tests passed, but none of them asserted anything
 * untested  no test claims it
 * insufficient  the tests would make it met, but its evidence level is below the level it requires
 */
export type Verdict = 'met' | 'failed' | 'unproven' | 'untested' | 'insufficient';

export interface TestOutcome {
  title: string;
  /** Runner result status: passed | failed | flaky | timed-out | skipped | ... */
  status: string;
  /** Trace or video path backing the verdict. */
  evidence?: string;
  /** Assertions the test made. Undefined means the runner did not say. */
  assertions?: number;
  /** Set by lint: criterion ids this test claims but shares no key word with. Such a test cannot lift those criteria to E2. */
  unrelatedTo?: string[];
  /** Source file of the test when the runner says (JUnit file=, CTRF filePath, Playwright location). Lint uses it to tell same-named tests apart. */
  file?: string;
}

export interface LedgerEntry {
  id: string;
  text: string;
  verdict: Verdict;
  tests: TestOutcome[];
  /** Titles of passing tests that asserted nothing. */
  weak?: string[];
  /** Evidence level achieved (E0-E4). Absent on ledgers written before evidence levels. */
  level?: EvidenceLevel;
  /** Evidence level the proof line (or --min-level) required when the ledger was built. */
  required?: EvidenceLevel;
  /** gaps[i] is what is missing to reach level + 1 + i. */
  gaps?: string[];
}

export interface Ledger {
  issue: string;
  title: string;
  entries: LedgerEntry[];
  /** True only when every criterion is met. Untested and unproven never count as a pass. */
  proven: boolean;
  /** sha256 of the results file okproof ingest read. Absent on ledgers not written by ingest. */
  results_sha256?: string;
  /** sha256 of the proof file text the ledger was built from. */
  proof_sha256?: string;
  /** Which run wrote the ledger: the commit it was built on (GITHUB_SHA, else git HEAD), the CI run id if any, and when. */
  run?: { commit?: string; run_id?: string; at: string };
}

export interface LedgerOptions {
  /** Treat a test whose assertion count is unknown as weak. Default false. */
  strictAssertions?: boolean;
  /** Level required of a criterion whose proof line names none. Default E2. */
  minLevel?: EvidenceLevel;
  /** Adversarial evidence per criterion id (see readAdversarial). */
  adversarial?: Map<string, Adversarial>;
  /** Where the results came from; both parts must hold for E4. */
  ci?: CiContext;
}

/** A test is weak when it is known to assert nothing (or, in strict mode, when that is not known). */
export function isWeak(outcome: TestOutcome, strict = false): boolean {
  return outcome.assertions === 0 || (strict && outcome.assertions === undefined);
}

export function buildLedger(proof: ProofFile, outcomes: TestOutcome[], options: LedgerOptions = {}): Ledger {
  const strict = options.strictAssertions === true;
  const entries = proof.criteria.map<LedgerEntry>((c) => {
    const tests = outcomes.filter((o) => claimedCriteria(o.title).includes(c.id));
    let verdict: Verdict = 'untested';
    const weak = tests.filter((t) => t.status === 'passed' && isWeak(t, strict)).map((t) => t.title);
    if (tests.length > 0) {
      // A flaky pass is not proof: every claiming test must pass cleanly.
      if (!tests.every((t) => t.status === 'passed')) verdict = 'failed';
      // Silence is not proof: a pass that asserted nothing proves nothing.
      else if (weak.length === tests.length) verdict = 'unproven';
      else verdict = 'met';
    }
    const grade = gradeEvidence({ id: c.id, base: verdict as 'met' | 'failed' | 'unproven' | 'untested', tests, weak, adversarial: options.adversarial?.get(c.id), ci: options.ci });
    const required = requiredLevel(c, options.minLevel ?? DEFAULT_MIN_LEVEL);
    // Met needs the evidence the criterion asks for, on top of the test rules.
    if (verdict === 'met' && grade.level < required) verdict = 'insufficient';
    const entry: LedgerEntry = { id: c.id, text: c.text, verdict, tests, level: grade.level, required };
    if (grade.gaps.length > 0) entry.gaps = grade.gaps;
    if (weak.length > 0) entry.weak = weak;
    return entry;
  });
  return {
    issue: proof.issue,
    title: proof.title,
    entries,
    proven: entries.every((e) => e.verdict === 'met'),
  };
}

const MARK: Record<Verdict, string> = { met: 'met', failed: 'FAILED', unproven: 'UNPROVEN (no assertions)', untested: 'untested', insufficient: 'INSUFFICIENT EVIDENCE' };

/** Human label for a verdict, shared by the markdown ledger and other renderers. */
export function verdictLabel(verdict: Verdict): string {
  return MARK[verdict] ?? String(verdict);
}

// Escape backslashes first, then pipes, so a trailing "\" can't un-escape a
// table separator (CodeQL js/incomplete-sanitization).
const pipes = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function renderLedgerMarkdown(ledger: Ledger): string {
  const met = ledger.entries.filter((e) => e.verdict === 'met').length;
  const lines = [
    `### okproof · #${ledger.issue} ${ledger.title}`,
    '',
    `${ledger.proven ? 'Proven' : 'Not proven'}: ${met} of ${ledger.entries.length} criteria met.`,
    '',
    '| Criterion | Verdict | Level | Evidence |',
    '| --- | --- | --- | --- |',
    ...ledger.entries.map((e) => {
      let evidence = e.tests.map((t) => t.evidence).filter(Boolean).join(', ') || '—';
      if (e.verdict === 'unproven') {
        evidence = `weak tests, add a real assertion: ${(e.weak ?? e.tests.map((t) => t.title)).join(', ')}`;
      }
      if (e.verdict === 'insufficient' && e.gaps?.[0]) evidence = `needs E${e.required}: ${e.gaps.slice(0, Math.max(1, (e.required ?? 0) - (e.level ?? 0))).join('; then ')}`;
      const level = e.level === undefined || e.required === undefined ? '—' : formatLevel(e.level, e.required);
      return `| ${pipes(`${e.id} ${e.text}`)} | ${MARK[e.verdict]} | ${level} | ${pipes(evidence)} |`;
    }),
    '',
    'Levels: E0 claimed · E1 a tagged test passed · E2 solid test · E3 survived adversarial verification · E4 proven in CI.',
  ];
  return lines.join('\n') + '\n';
}
