#!/usr/bin/env node
// probato check [dir]  validates proof files and prints the tag for each criterion.
// probato gate  [dir]  exits 1 when any written ledger is not proven (a merge gate).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof } from './proof.js';

const [cmd = 'check', dir = '.probato'] = process.argv.slice(2);

async function main(): Promise<number> {
  const names = await readdir(dir);
  if (cmd === 'check') {
    for (const f of names.filter((n) => n.endsWith('.md') && !n.startsWith('ledger-'))) {
      const proof = parseProof(await readFile(join(dir, f), 'utf8'));
      console.log(`#${proof.issue} ${proof.title}`);
      for (const c of proof.criteria) console.log(`  [probato:${c.id}] ${c.text}`);
    }
    return 0;
  }
  if (cmd === 'gate') {
    const ledgers = names.filter((n) => n.startsWith('ledger-') && n.endsWith('.json'));
    if (ledgers.length === 0) {
      console.error('No ledgers found. Run the suite with the probato() reporter first.');
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
  console.error(`Unknown command "${cmd}". Use: probato check | probato gate`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(2);
  },
);
