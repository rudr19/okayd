import { claimedCriteria, type ProofFile } from './proof.js';

/**
 * met       every claiming test passed and at least one made a real assertion
 * failed    a claiming test failed, was flaky, skipped, timed out, ...
 * unproven  claiming tests passed, but none of them asserted anything
 * untested  no test claims it
 */
export type Verdict = 'met' | 'failed' | 'unproven' | 'untested';

export interface TestOutcome {
  title: string;
  /** Runner result status: passed | failed | flaky | timed-out | skipped | ... */
  status: string;
  /** Trace or video path backing the verdict. */
  evidence?: string;
  /** Assertions the test made. Undefined means the runner did not say. */
  assertions?: number;
}

export interface LedgerEntry {
  id: string;
  text: string;
  verdict: Verdict;
  tests: TestOutcome[];
  /** Titles of passing tests that asserted nothing. */
  weak?: string[];
}

export interface Ledger {
  issue: string;
  title: string;
  entries: LedgerEntry[];
  /** True only when every criterion is met. Untested and unproven never count as a pass. */
  proven: boolean;
}

export interface LedgerOptions {
  /** Treat a test whose assertion count is unknown as weak. Default false. */
  strictAssertions?: boolean;
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
    const entry: LedgerEntry = { id: c.id, text: c.text, verdict, tests };
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

const MARK: Record<Verdict, string> = { met: 'met', failed: 'FAILED', unproven: 'UNPROVEN (no assertions)', untested: 'untested' };

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
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...ledger.entries.map((e) => {
      let evidence = e.tests.map((t) => t.evidence).filter(Boolean).join(', ') || '—';
      if (e.verdict === 'unproven') {
        evidence = `weak tests, add a real assertion: ${(e.weak ?? e.tests.map((t) => t.title)).join(', ')}`;
      }
      return `| ${pipes(`${e.id} ${e.text}`)} | ${MARK[e.verdict]} | ${pipes(evidence)} |`;
    }),
  ];
  return lines.join('\n') + '\n';
}
