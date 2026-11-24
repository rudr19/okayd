#!/usr/bin/env node
// okayd check  [dir]              validate proof files and print each criterion's tag
// okayd ingest <junit.xml> [dir]  build ledgers from any runner's JUnit XML
// okayd gate   [dir]              exit 1 unless every written ledger is proven
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';
import { parseJUnit } from './junit.js';
import { finalize } from './finalize.js';
import { AnthropicModel, MISSING_KEY_MESSAGE, type Effort } from './verify/model.js';
import { replayOnly, verify } from './verify/run.js';

const USAGE = 'Usage: okayd check [dir] | okayd ingest <junit.xml> [dir] | okayd gate [dir] | okayd verify --url <baseUrl> [options]';
const args = process.argv.slice(2);

// okayd verify --url <baseUrl> [--issue N] [--dir .okayd] [--max-steps 15] [--model id] [--effort e] [--replay-only]
function flags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), true);
    else { out.set(a.slice(2), next); i++; }
  }
  return out;
}

async function runVerify(): Promise<number> {
  const f = flags(args.slice(1));
  const str = (k: string): string | undefined => (typeof f.get(k) === 'string' ? (f.get(k) as string) : undefined);
  const dir = str('dir') ?? '.okayd';
  const issue = str('issue');
  const url = str('url');
  if (f.get('replay-only') === true) {
    const results = await replayOnly({ dir, issue, baseUrl: url, chrome: process.env.OKAYD_CHROME });
    if (results.length === 0) {
      console.error(`No repro files in ${dir}/repro. Run okayd verify first.`);
      return 2;
    }
    let reproduced = false;
    for (const r of results) {
      console.log(`${r.criterionId}: ${r.reproduced ? 'BUG REPRODUCED' : 'not reproduced'}`);
      for (const l of r.lines) console.log(`  ${l}`);
      reproduced ||= r.reproduced;
    }
    return reproduced ? 1 : 0;
  }
  if (!url) {
    console.error(`Name the app to test with --url <baseUrl>. ${USAGE}`);
    return 2;
  }
  let model: AnthropicModel;
  try {
    model = new AnthropicModel({ model: str('model'), effort: str('effort') as Effort | undefined });
  } catch (e) {
    const message = (e as Error).message;
    console.error(message === MISSING_KEY_MESSAGE ? `${message}\nTo re-run saved repro scripts without a model, add --replay-only.` : message);
    return 2;
  }
  const runs = await verify({ dir, issue, baseUrl: url, model, maxSteps: Number(str('max-steps') ?? 15), log: (l) => console.log(l) });
  let refuted = false;
  for (const run of runs) {
    for (const r of run.results) {
      console.log(`${r.criterionId}: ${r.verdict}${r.repro ? ` (repro: ${r.repro})` : ''}`);
      for (const x of r.findings) console.log(`  ${x.confirmed ? 'confirmed' : 'unconfirmed'} [${x.severity}] ${x.title}`);
      refuted ||= r.verdict === 'refuted';
    }
  }
  return refuted ? 1 : 0;
}
const cmd = args[0] ?? 'check';

async function main(): Promise<number> {
  if (cmd === 'check') {
    const dir = args[1] ?? '.okayd';
    for (const f of (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('ledger-'))) {
      const proof = parseProof(await readFile(join(dir, f), 'utf8'));
      console.log(`#${proof.issue} ${proof.title}`);
      for (const c of proof.criteria) console.log(`  [okayd:${c.id}] ${c.text}`);
    }
    return 0;
  }
  if (cmd === 'ingest') {
    const file = args[1];
    if (!file) {
      console.error(`Name the JUnit XML file to read. ${USAGE}`);
      return 2;
    }
    const { lines } = await finalize(parseJUnit(await readFile(file, 'utf8')), { dir: args[2] ?? '.okayd' });
    for (const line of lines) console.log(line);
    return 0;
  }
  if (cmd === 'gate') {
    const dir = args[1] ?? '.okayd';
    const ledgers = (await readdir(dir)).filter((n) => n.startsWith('ledger-') && n.endsWith('.json'));
    if (ledgers.length === 0) {
      console.error('No ledgers found. Run your tests with the Okayd reporter, or run okayd ingest, first.');
      return 1;
    }
    let ok = true;
    for (const f of ledgers) {
      const ledger = JSON.parse(await readFile(join(dir, f), 'utf8'));
      if (!ledger.proven) {
        ok = false;
        console.error(`#${ledger.issue} is not proven`);
      }
    }
    return ok ? 0 : 1;
  }
  if (cmd === 'verify') return runVerify();
  console.error(`Unknown command "${cmd}". ${USAGE}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(2);
  },
);
