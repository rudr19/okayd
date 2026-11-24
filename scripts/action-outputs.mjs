// Used by action.yml: writes the `proven` and `summary` outputs from the
// ledgers in $DIR. Missing or empty ledgers count as not proven.
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dir = process.env.DIR || '.okproof';
const lines = [];
let proven = false;
try {
  const files = readdirSync(dir).filter((n) => n.startsWith('ledger-') && n.endsWith('.json')).sort();
  proven = files.length > 0;
  for (const f of files) {
    const ledger = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const met = ledger.entries.filter((e) => e.verdict === 'met').length;
    if (!ledger.proven) proven = false;
    lines.push(`okproof #${ledger.issue}: ${met}/${ledger.entries.length} criteria met, ${ledger.proven ? 'proven' : 'not proven'}`);
  }
} catch {
  proven = false;
}
const out = process.env.GITHUB_OUTPUT;
const text = `proven=${proven}\n`;
if (out) {
  const delim = `OKPROOF_${randomUUID()}`;
  appendFileSync(out, `${text}summary<<${delim}\n${lines.join('\n')}\n${delim}\n`);
} else {
  process.stdout.write(`${text}${lines.join('\n')}\n`);
}
