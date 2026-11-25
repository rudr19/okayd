// Used by action.yml: writes the `proven` and `summary` outputs. The verdict
// comes from the same gate function as `okproof gate` (proof files are the
// source of truth), never from a ledger's own `proven` field, so a stale,
// missing or unmet ledger is "not proven" here too.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateGate } from '../dist/src/gate.js';
import { parseLevel } from '../dist/src/evidence.js';

const dir = process.env.DIR || '.okproof';
let proven = false;
const lines = [];
try {
  const minLevel = process.env.MIN_LEVEL ? parseLevel(process.env.MIN_LEVEL) : undefined;
  // With a results input, ingest rebuilt the ledgers in this job: they are the same evidence the gate step uses (E4 included).
  let ledgers;
  if (process.env.RESULTS) {
    ledgers = [];
    for (const n of (await readdir(dir)).filter((f) => f.startsWith('ledger-') && f.endsWith('.json')).sort()) {
      try { ledgers.push(JSON.parse(await readFile(join(dir, n), 'utf8'))); } catch { /* evaluateGate reports the missing ledger */ }
    }
  }
  const result = await evaluateGate(dir, { minLevel, allowEmpty: process.env.OKPROOF_ALLOW_EMPTY === '1', ...(ledgers ? { ledgers } : {}) });
  proven = result.ok;
  lines.push(...result.notes.map((n) => `okproof ${n}`), ...result.problems.map((p) => `okproof not proven: ${p}`));
  if (lines.length === 0) lines.push(proven ? 'okproof: proven' : 'okproof: not proven');
} catch (e) {
  proven = false;
  lines.push(`okproof not proven: ${e.message}`);
}
const out = process.env.GITHUB_OUTPUT;
const text = `proven=${proven}\n`;
if (out) {
  const delim = `OKPROOF_${randomUUID()}`;
  appendFileSync(out, `${text}summary<<${delim}\n${lines.join('\n')}\n${delim}\n`);
} else {
  process.stdout.write(`${text}${lines.join('\n')}\n`);
}
