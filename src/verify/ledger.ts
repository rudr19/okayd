// Feeds verifier results into the ledger. A confirmed refutation fails the
// criterion no matter what the tests said.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ledger } from '../ledger.js';
import { REFUTE_SEVERITY } from './detectors.js';
import type { VerifyFile } from './types.js';

export async function readVerifyFile(dir: string, issue: string): Promise<VerifyFile | undefined> {
  let source: string;
  try {
    source = await readFile(join(dir, `verify-${issue}.json`), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(source) as VerifyFile;
  } catch {
    throw new Error(`${join(dir, `verify-${issue}.json`)} is not valid JSON. Delete it or rerun okayd verify.`);
  }
}

export function applyVerifyFile(ledger: Ledger, file: VerifyFile): Ledger {
  for (const result of file.results) {
    if (result.verdict !== 'refuted') continue;
    const entry = ledger.entries.find((e) => e.id === result.criterionId);
    if (!entry) continue;
    const finding = result.findings.find((f) => f.confirmed && f.severity >= REFUTE_SEVERITY);
    const title = (finding?.title ?? 'confirmed bug').replace(/\|/g, '/').replace(/\s+/g, ' ');
    const repro = result.repro ?? `.okayd/repro/${result.criterionId}.json`;
    entry.verdict = 'failed';
    entry.tests.push({ title: `verifier [okayd:${entry.id}]`, status: 'failed', evidence: `refuted by verifier: ${title} (repro: ${repro})` });
  }
  ledger.proven = ledger.entries.every((e) => e.verdict === 'met');
  return ledger;
}
