// e2e reporter: collects test results, maps them to criteria, writes the ledger.
// Shape per e2e docs (reference/reporters.mdx): { name, onEvent?, onRunFinished? },
// where onRunFinished may return { rows } printed under the run summary.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';
import { buildLedger, renderLedgerMarkdown, type Ledger, type TestOutcome } from './ledger.js';
import { publishToGitHub } from './github.js';

export interface OkaydOptions {
  /** Folder holding proof files. Default ".okayd". */
  dir?: string;
  /** Only check this issue's proof file. Default: every proof file in dir. */
  issue?: string;
  /** Post the ledger as a PR comment and job summary in GitHub Actions. Default true. */
  github?: boolean;
}

interface RunEvent {
  type: string;
  result?: { test?: { title?: string }; status?: string; tracePath?: string };
}

export function okayd(options: OkaydOptions = {}) {
  const dir = options.dir ?? '.okayd';
  const outcomes: TestOutcome[] = [];
  return {
    name: 'okayd',
    onEvent(event: RunEvent) {
      if (event.type !== 'test-finished' || !event.result?.test?.title) return;
      outcomes.push({
        title: event.result.test.title,
        status: event.result.status ?? 'unknown',
        evidence: event.result.tracePath,
      });
    },
    async onRunFinished() {
      const files = (await readdir(dir)).filter(
        (f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!options.issue || f === `${options.issue}.md`),
      );
      const rows: string[] = [];
      const ledgers: Ledger[] = [];
      for (const f of files) {
        const ledger = buildLedger(parseProof(await readFile(join(dir, f), 'utf8')), outcomes);
        ledgers.push(ledger);
        await writeFile(join(dir, `ledger-${ledger.issue}.json`), JSON.stringify(ledger, null, 2));
        await writeFile(join(dir, `ledger-${ledger.issue}.md`), renderLedgerMarkdown(ledger));
        const met = ledger.entries.filter((e) => e.verdict === 'met').length;
        rows.push(`okayd #${ledger.issue}: ${met}/${ledger.entries.length} criteria met${ledger.proven ? '' : ' (not proven)'}`);
      }
      if (options.github !== false && ledgers.length > 0) {
        const published = await publishToGitHub(ledgers);
        if (published.comment !== 'skipped') rows.push(`okayd: pull request comment ${published.comment}`);
        else if (published.reason !== 'not running in GitHub Actions') rows.push(`okayd: no PR comment (${published.reason})`);
      }
      return { rows };
    },
  };
}
