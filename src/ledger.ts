import { claimedCriteria, type ProofFile } from './proof.js';

export type Verdict = 'met' | 'failed' | 'untested';

export interface TestOutcome {
  title: string;
  /** e2e result status: passed | failed | flaky | timed-out | skipped | ... */
  status: string;
  /** Trace or video path backing the verdict. */
  evidence?: string;
}

export interface LedgerEntry {
  id: string;
  text: string;
  verdict: Verdict;
  tests: TestOutcome[];
}

export interface Ledger {
  issue: string;
  title: string;
  entries: LedgerEntry[];
  /** True only when every criterion is met. Untested never counts as a pass. */
  proven: boolean;
}

export function buildLedger(proof: ProofFile, outcomes: TestOutcome[]): Ledger {
  const entries = proof.criteria.map<LedgerEntry>((c) => {
    const tests = outcomes.filter((o) => claimedCriteria(o.title).includes(c.id));
    let verdict: Verdict = 'untested';
    if (tests.length > 0) {
      // A flaky pass is not proof: every claiming test must pass cleanly.
      verdict = tests.every((t) => t.status === 'passed') ? 'met' : 'failed';
    }
    return { id: c.id, text: c.text, verdict, tests };
  });
  return {
    issue: proof.issue,
    title: proof.title,
    entries,
    proven: entries.every((e) => e.verdict === 'met'),
  };
}

const MARK: Record<Verdict, string> = { met: 'met', failed: 'FAILED', untested: 'untested' };

export function renderLedgerMarkdown(ledger: Ledger): string {
  const met = ledger.entries.filter((e) => e.verdict === 'met').length;
  const lines = [
    `### Probato · #${ledger.issue} ${ledger.title}`,
    '',
    `${ledger.proven ? 'Proven' : 'Not proven'}: ${met} of ${ledger.entries.length} criteria met.`,
    '',
    '| Criterion | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...ledger.entries.map((e) => {
      const evidence = e.tests.map((t) => t.evidence).filter(Boolean).join(', ') || '—';
      return `| ${e.id} ${e.text.replace(/\|/g, '\\|')} | ${MARK[e.verdict]} | ${evidence} |`;
    }),
  ];
  return lines.join('\n') + '\n';
}
