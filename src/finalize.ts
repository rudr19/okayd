// Runner-neutral core: turn test outcomes into ledgers, write them, and
// publish them. Every adapter (Playwright, JUnit, ...) ends here.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';
import { buildLedger, renderLedgerMarkdown, type Ledger, type TestOutcome } from './ledger.js';
import { publishToGitHub } from './github.js';
import { evaluateGate } from './gate.js';
import { sha256Hex } from './trust.js';
import { applyVerifyFile, criteriaHash, readVerifyFile } from './verify/ledger.js';

export interface FinalizeOptions {
  /** Folder holding proof files. Default ".okproof". */
  dir?: string;
  /** Only check this issue's proof file. Default: every proof file in dir. */
  issue?: string;
  /** Post the ledger as a PR comment and job summary in GitHub Actions. Default true. */
  github?: boolean;
  /**
   * Treat a test whose assertion count is unknown as weak (unproven).
   * Default: true only when OKPROOF_STRICT_ASSERTIONS=1.
   */
  strictAssertions?: boolean;
  /** sha256 of the results file, recorded in each ledger as results_sha256. */
  resultsSha256?: string;
}

export interface FinalizeResult {
  ledgers: Ledger[];
  /** Human-readable lines for the runner's output. */
  lines: string[];
}

export async function finalize(outcomes: TestOutcome[], options: FinalizeOptions = {}): Promise<FinalizeResult> {
  const dir = options.dir ?? '.okproof';
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!options.issue || f === `${options.issue}.md`),
  );
  const strict = options.strictAssertions ?? process.env.OKPROOF_STRICT_ASSERTIONS === '1';
  const ledgers: Ledger[] = [];
  const lines: string[] = [];
  for (const f of files) {
    const proofText = await readFile(join(dir, f), 'utf8');
    const proof = parseProof(proofText);
    let ledger: Ledger = { ...buildLedger(proof, outcomes, { strictAssertions: strict }), ...(options.resultsSha256 ? { results_sha256: options.resultsSha256 } : {}), proof_sha256: sha256Hex(proofText) };
    // A criterion the verifier refuted (and replay confirmed) fails regardless of tests.
    const verified = await readVerifyFile(dir, ledger.issue);
    if (verified && verified.criteriaHash === criteriaHash(proof)) ledger = applyVerifyFile(ledger, verified);
    else if (verified) lines.push(`okproof #${ledger.issue}: verifier results are stale; re-run okproof verify or delete verify-${ledger.issue}.json (okproof gate will fail until then)`);
    ledgers.push(ledger);
    await writeFile(join(dir, `ledger-${ledger.issue}.json`), JSON.stringify(ledger, null, 2));
    await writeFile(join(dir, `ledger-${ledger.issue}.md`), renderLedgerMarkdown(ledger));
    const met = ledger.entries.filter((e) => e.verdict === 'met').length;
    const unproven = ledger.entries.filter((e) => e.verdict === 'unproven').length;
    const weakNote = unproven > 0 ? `, ${unproven} unproven (no assertions)` : '';
    lines.push(`okproof #${ledger.issue}: ${met}/${ledger.entries.length} criteria met${weakNote}, ${ledger.proven ? 'proven' : 'not proven'}`);
  }
  if (options.github !== false && ledgers.length > 0) {
    const published = await publishToGitHub(ledgers, undefined, undefined, await evaluateGate(dir, { issue: options.issue }));
    if (published.comment !== 'skipped') lines.push(`okproof: pull request comment ${published.comment}`);
    else if (published.reason !== 'not running in GitHub Actions') lines.push(`okproof: no PR comment (${published.reason})`);
  }
  return { ledgers, lines };
}
