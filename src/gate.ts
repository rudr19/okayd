// The merge gate. The proof files are the source of truth: a ledger is only a
// record of one test run, so the gate re-reads every proof file and checks the
// ledger against it. It never trusts a ledger's own `proven` field.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof, type ProofFile } from './proof.js';
import type { Ledger } from './ledger.js';

export interface GateOptions {
  /** Pass when there is nothing to prove (no folder or no proof files). Default false. */
  allowEmpty?: boolean;
}

export interface GateResult {
  ok: boolean;
  /** One line per reason the gate failed. Empty when ok. */
  problems: string[];
  /** One line per proof file that passed or was checked, for the log. */
  notes: string[];
}

const RERUN = 'Re-run your tests (or okayd ingest) to rebuild the ledger.';

/** Why a ledger no longer describes its proof file, or undefined if it still does. */
export function staleness(proof: ProofFile, ledger: Ledger): string | undefined {
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const have = new Map(entries.map((e) => [e.id, e.text]));
  const want = new Map(proof.criteria.map((c) => [c.id, c.text]));
  const added = [...want.keys()].filter((id) => !have.has(id));
  const removed = [...have.keys()].filter((id) => !want.has(id));
  const edited = [...want.keys()].filter((id) => have.has(id) && have.get(id) !== want.get(id));
  if (added.length + removed.length + edited.length === 0 && entries.length === proof.criteria.length) return undefined;
  const parts = [
    added.length ? `added ${added.join(', ')}` : '',
    removed.length ? `removed ${removed.join(', ')}` : '',
    edited.length ? `edited ${edited.join(', ')}` : '',
  ].filter(Boolean);
  return `#${proof.issue} STALE: the proof file changed after the ledger was written (${parts.join('; ') || 'duplicate criteria'}). ${RERUN}`;
}

export async function evaluateGate(dir: string, options: GateOptions = {}): Promise<GateResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const proofFiles = names.filter((n) => n.endsWith('.md') && !n.startsWith('ledger-')).sort();
  const ledgerFiles = names.filter((n) => n.startsWith('ledger-') && n.endsWith('.json')).sort();

  if (proofFiles.length === 0 && ledgerFiles.length === 0) {
    if (options.allowEmpty) return { ok: true, problems, notes: [`No proof files in ${dir}; nothing to prove (--allow-empty).`] };
    return {
      ok: false,
      problems: [`No proof files in ${dir}, so there is nothing to prove. Add .okayd/<issue>.md with the acceptance criteria, or pass --allow-empty if this change has none.`],
      notes,
    };
  }

  const seen = new Set<string>();
  for (const f of proofFiles) {
    let proof: ProofFile;
    try {
      proof = parseProof(await readFile(join(dir, f), 'utf8'));
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message}`);
      continue;
    }
    if (seen.has(proof.issue)) {
      problems.push(`#${proof.issue}: more than one proof file describes this issue (${f}).`);
      continue;
    }
    seen.add(proof.issue);

    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(join(dir, `ledger-${proof.issue}.json`), 'utf8')) as Ledger;
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      problems.push(
        missing
          ? `#${proof.issue} has no ledger. Run your tests with the Okayd reporter, or run okayd ingest, first.`
          : `#${proof.issue}: ledger-${proof.issue}.json is not valid JSON. ${RERUN}`,
      );
      continue;
    }

    const stale = staleness(proof, ledger);
    if (stale) {
      problems.push(stale);
      continue;
    }
    // Verdict from the entries themselves, in the proof file's order.
    const entries = new Map(ledger.entries.map((e) => [e.id, e]));
    const unmet = proof.criteria.filter((c) => entries.get(c.id)?.verdict !== 'met');
    if (unmet.length > 0) {
      for (const c of unmet) problems.push(`#${proof.issue} criterion ${c.id} is ${entries.get(c.id)?.verdict ?? 'untested'}: ${c.text}`);
    } else {
      notes.push(`#${proof.issue}: ${proof.criteria.length}/${proof.criteria.length} criteria met`);
    }
  }

  // A ledger with no proof file means a proof file was deleted.
  for (const f of ledgerFiles) {
    const issue = f.slice('ledger-'.length, -'.json'.length);
    if (!seen.has(issue) && !proofFiles.some((p) => p === `${issue}.md`)) {
      problems.push(`#${issue} has a ledger but no proof file. If the proof file was deleted on purpose, delete ${f} too.`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}
