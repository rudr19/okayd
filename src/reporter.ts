// e2e reporter: collects test results, maps them to criteria, writes the ledger.
// Shape per e2e 0.24 docs (reference/reporters.mdx):
//   { name, onEvent?(event), onRunFinished?(run, signal) => { label, text }[] }
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

/** The parts of e2e's RunEventResult that Okayd reads. */
interface RunEventResult {
  test?: { id?: string; title?: string };
  status?: string;
  attempts?: Array<{ id?: string; durationMs?: number; environment?: Record<string, string> }>;
}

interface RunEvent {
  type: string;
  result?: RunEventResult;
}

interface FinishedRun {
  /** result id -> trace page path, written for failed attempts. */
  traces?: ReadonlyMap<string, string>;
}

/** One summary row as e2e prints it under the run summary. */
export interface SummaryRow {
  label: string;
  text: string;
}

interface Collected extends TestOutcome {
  keys: string[];
}

function describeAttempt(result: RunEventResult): string | undefined {
  const last = result.attempts?.at(-1);
  if (!last) return undefined;
  const seconds = last.durationMs !== undefined ? `${(last.durationMs / 1000).toFixed(1)}s` : undefined;
  const browser = last.environment?.browser;
  return [result.status, seconds && `in ${seconds}`, browser && `on ${browser}`].filter(Boolean).join(' ');
}

export function okayd(options: OkaydOptions = {}) {
  const dir = options.dir ?? '.okayd';
  const collected: Collected[] = [];
  return {
    name: 'okayd',
    onEvent(event: RunEvent) {
      const result = event.result;
      if (event.type !== 'test-finished' || !result?.test?.title) return;
      collected.push({
        title: result.test.title,
        status: result.status ?? 'unknown',
        evidence: describeAttempt(result),
        keys: [result.test.id, ...(result.attempts ?? []).map((a) => a.id)].filter((k): k is string => !!k),
      });
    },
    async onRunFinished(run?: FinishedRun): Promise<SummaryRow[]> {
      // A failed attempt gets a trace page: prefer it as evidence.
      const outcomes: TestOutcome[] = collected.map(({ keys, ...o }) => {
        const trace = keys.map((k) => run?.traces?.get(k)).find(Boolean);
        return trace ? { ...o, evidence: trace } : o;
      });
      const files = (await readdir(dir)).filter(
        (f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!options.issue || f === `${options.issue}.md`),
      );
      const rows: SummaryRow[] = [];
      const ledgers: Ledger[] = [];
      for (const f of files) {
        const ledger = buildLedger(parseProof(await readFile(join(dir, f), 'utf8')), outcomes);
        ledgers.push(ledger);
        await writeFile(join(dir, `ledger-${ledger.issue}.json`), JSON.stringify(ledger, null, 2));
        await writeFile(join(dir, `ledger-${ledger.issue}.md`), renderLedgerMarkdown(ledger));
        const met = ledger.entries.filter((e) => e.verdict === 'met').length;
        rows.push({
          label: `okayd #${ledger.issue}`,
          text: `${met}/${ledger.entries.length} criteria met${ledger.proven ? ', proven' : ', not proven'}`,
        });
      }
      if (options.github !== false && ledgers.length > 0) {
        const published = await publishToGitHub(ledgers);
        if (published.comment !== 'skipped') rows.push({ label: 'okayd', text: `pull request comment ${published.comment}` });
        else if (published.reason !== 'not running in GitHub Actions') rows.push({ label: 'okayd', text: `no PR comment (${published.reason})` });
      }
      return rows;
    },
  };
}
