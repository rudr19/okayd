// Used by action.yml: writes the `proven` and `summary` outputs. The verdict
// comes from the same gate function as `okproof gate` (proof files are the
// source of truth), never from a ledger's own `proven` field, so a stale,
// missing or unmet ledger is "not proven" here too.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { evaluateGate } from '../dist/src/gate.js';

const dir = process.env.DIR || '.okproof';
let proven = false;
const lines = [];
try {
  const result = await evaluateGate(dir);
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
