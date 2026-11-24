// The merge gate. The proof files are the source of truth: a ledger is only a
// record of one test run, so the gate re-reads every proof file and checks the
// ledger against it. It never trusts a ledger's own `proven` field.
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof, type ProofFile } from './proof.js';
import type { Ledger } from './ledger.js';
import { criteriaHash, readVerifyFile } from './verify/ledger.js';

export interface GateOptions {
  /** Pass when there is nothing to prove (no folder or no proof files). Default false. */
  allowEmpty?: boolean;
  /** Only check this issue (its proof file, ledger and verifier file). */
  issue?: string;
  /** Ledgers rebuilt in memory from this job's test results (trust.ts). When set, committed ledgers are ignored. */
  ledgers?: Ledger[];
}

export interface GateResult {
  ok: boolean;
  /** One line per reason the gate failed. Empty when ok. */
  problems: string[];
  /** One line per proof file that passed or was checked, for the log. */
  notes: string[];
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** Verifier-file problems for one proof file (stale hash), plus an optional note. */
async function verifyCheck(dir: string, proof: ProofFile): Promise<{ problem?: string; note?: string }> {
  let file;
  try {
    file = await readVerifyFile(dir, proof.issue);
  } catch (e) {
    return { problem: `#${proof.issue}: ${(e as Error).message}` };
  }
  if (file) {
    if (file.criteriaHash !== criteriaHash(proof)) {
      return { problem: `#${proof.issue}: verifier results are stale; re-run okproof verify or delete the file (verify-${proof.issue}.json was not written for the current criteria).` };
    }
    return {};
  }
  for (const c of proof.criteria) {
    if (await exists(join(dir, 'repro', `${c.id}.json`))) {
      return { note: `#${proof.issue}: a repro file exists for ${c.id} but verify-${proof.issue}.json is missing; refutations are not being applied. Re-run okproof verify.` };
    }
  }
  return {};
}

const RERUN = 'Re-run your tests (or okproof ingest) to rebuild the ledger.';

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
  const only = options.issue;
  const proofFiles = names.filter((n) => n.endsWith('.md') && !n.startsWith('ledger-') && (!only || n === `${only}.md`)).sort();
  const ledgerFiles = names.filter((n) => n.startsWith('ledger-') && n.endsWith('.json') && (!only || n === `ledger-${only}.json`)).sort();

  if (proofFiles.length === 0 && ledgerFiles.length === 0) {
    if (options.allowEmpty) return { ok: true, problems, notes: [`No proof files in ${dir}; nothing to prove (--allow-empty).`] };
    return {
      ok: false,
      problems: [`No proof files in ${dir}, so there is nothing to prove. Add .okproof/<issue>.md with the acceptance criteria, or pass --allow-empty if this change has none.`],
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

    const v = await verifyCheck(dir, proof);
    if (v.problem) problems.push(v.problem);
    if (v.note) notes.push(v.note);

    const injected = options.ledgers?.find((l) => l.issue === proof.issue);
    if (options.ledgers && !injected) {
      problems.push(`#${proof.issue} has no ledger rebuilt from the test results.`);
      continue;
    }
    let ledger: Ledger;
    try {
      ledger = injected ?? (JSON.parse(await readFile(join(dir, `ledger-${proof.issue}.json`), 'utf8')) as Ledger);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      problems.push(
        missing
          ? `#${proof.issue} has no ledger. Run your tests with the okproof reporter, or run okproof ingest, first.`
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
      for (const c of unmet) {
        const e = entries.get(c.id) as { verdict?: string; weak?: string[] } | undefined;
        if (e?.verdict === 'unproven') {
          problems.push(`#${proof.issue} criterion ${c.id} is UNPROVEN (no assertions): add a real assertion to ${(e.weak ?? []).join(', ') || 'its tagged tests'}. ${c.text}`);
        } else {
          problems.push(`#${proof.issue} criterion ${c.id} is ${e?.verdict ?? 'untested'}: ${c.text}`);
        }
      }
    } else {
      notes.push(`#${proof.issue}: ${proof.criteria.length}/${proof.criteria.length} criteria met`);
    }
  }

  // A ledger with no proof file means a proof file was deleted.
  for (const f of options.ledgers ? [] : ledgerFiles) {
    const issue = f.slice('ledger-'.length, -'.json'.length);
    if (!seen.has(issue) && !proofFiles.some((p) => p === `${issue}.md`)) {
      problems.push(`#${issue} has a ledger but no proof file. If the proof file was deleted on purpose, delete ${f} too.`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}
