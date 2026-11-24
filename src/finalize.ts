// Runner-neutral core: turn test outcomes into ledgers, write them, and
// publish them. Every adapter (Playwright, JUnit, ...) ends here.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';
import { buildLedger, renderLedgerMarkdown, type Ledger, type TestOutcome } from './ledger.js';
import { publishToGitHub } from './github.js';
import { applyVerifyFile, readVerifyFile } from './verify/ledger.js';

export interface FinalizeOptions {
  /** Folder holding proof files. Default ".okayd". */
  dir?: string;
  /** Only check this issue's proof file. Default: every proof file in dir. */
  issue?: string;
  /** Post the ledger as a PR comment and job summary in GitHub Actions. Default true. */
  github?: boolean;
}

export interface FinalizeResult {
  ledgers: Ledger[];
  /** Human-readable lines for the runner's output. */
  lines: string[];
}

export async function finalize(outcomes: TestOutcome[], options: FinalizeOptions = {}): Promise<FinalizeResult> {
  const dir = options.dir ?? '.okayd';
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!options.issue || f === `${options.issue}.md`),
  );
  const ledgers: Ledger[] = [];
  const lines: string[] = [];
  for (const f of files) {
    let ledger = buildLedger(parseProof(await readFile(join(dir, f), 'utf8')), outcomes);
    // A criterion the verifier refuted (and replay confirmed) fails regardless of tests.
    const verified = await readVerifyFile(dir, ledger.issue);
    if (verified) ledger = applyVerifyFile(ledger, verified);
    ledgers.push(ledger);
    await writeFile(join(dir, `ledger-${ledger.issue}.json`), JSON.stringify(ledger, null, 2));
    await writeFile(join(dir, `ledger-${ledger.issue}.md`), renderLedgerMarkdown(ledger));
    const met = ledger.entries.filter((e) => e.verdict === 'met').length;
    lines.push(`okayd #${ledger.issue}: ${met}/${ledger.entries.length} criteria met, ${ledger.proven ? 'proven' : 'not proven'}`);
  }
  if (options.github !== false && ledgers.length > 0) {
    const published = await publishToGitHub(ledgers);
    if (published.comment !== 'skipped') lines.push(`okayd: pull request comment ${published.comment}`);
    else if (published.reason !== 'not running in GitHub Actions') lines.push(`okayd: no PR comment (${published.reason})`);
  }
  return { ledgers, lines };
}
