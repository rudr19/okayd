#!/usr/bin/env node
// okayd check  [dir]              validate proof files and print each criterion's tag
// okayd ingest <junit.xml> [dir]  build ledgers from any runner's JUnit XML
// okayd gate   [dir]              exit 1 unless every written ledger is proven
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';
import { parseJUnit } from './junit.js';
import { finalize } from './finalize.js';

const USAGE = 'Usage: okayd check [dir] | okayd ingest <junit.xml> [dir] | okayd gate [dir]';
const args = process.argv.slice(2);
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
