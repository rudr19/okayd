// Probes first, model second. For every criterion, run the probes whose keywords
// match it (no model, replay-confirmed). A criterion a probe refutes is done and
// costs zero tokens. The rest, those with no matching probe and those the probes
// could not refute, go to the model, unless --probes-only.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof, type Criterion } from '../proof.js';
import { prepareAuth } from './auth.js';
import { criteriaHash } from './ledger.js';
import type { ModelClient } from './model.js';
import { matchProbes, probeById, runProbe, type ProbeId, type ProbeResult } from './probes.js';
import { verifyOne, type VerifyOptions, type VerifyRun } from './run.js';
import type { ReproFile, ResultFinding, VerifyFile, VerifyResult } from './types.js';

export interface ProbeVerifyOptions extends Omit<VerifyOptions, 'model'> {
  /** 'first' runs probes, then the model for what is left. 'only' never calls a model. */
  mode: 'first' | 'only';
  /** The model, or a function that makes it when first needed, so a missing key matters only if some criterion reaches the model. */
  model?: ModelClient | (() => ModelClient);
}

export interface ProbeStats {
  criteria: number;
  /** Refuted by a probe, with no model. */
  refutedByProbes: number;
  /** Criteria no probe's keywords matched. */
  noMatchingProbe: number;
  /** Criteria that had matching probes but survived them. */
  survivedProbes: number;
  /** Criteria the model ran on. */
  modelUsed: number;
}

export interface ProbeVerifyOutcome {
  runs: VerifyRun[];
  stats: ProbeStats;
  /** Set when a criterion needed the model and none could be made (no key). */
  modelError?: string;
}

const slash = (p: string): string => p.replace(/\\/g, '/');

/** "probes covered 4/6 criteria; model used for 2" (and why). */
export function savingsLine(s: ProbeStats, mode: 'first' | 'only'): string {
  const rest = `${s.noMatchingProbe} had no matching probe, ${s.survivedProbes} survived their probes`;
  if (mode === 'only') return `probes-only: probes refuted ${s.refutedByProbes}/${s.criteria} criteria with 0 model tokens (${rest}); no model was run`;
  return `probes covered ${s.refutedByProbes}/${s.criteria} criteria with 0 model tokens; model used for ${s.modelUsed} (${rest})`;
}

const counts = (f: ResultFinding): boolean => f.confirmed && !f.downgraded;

async function proofFiles(dir: string, issue?: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!issue || f === `${issue}.md`));
}

export async function verifyWithProbes(o: ProbeVerifyOptions): Promise<ProbeVerifyOutcome> {
  const dir = o.dir ?? '.okproof';
  const prepared = await prepareAuth(o);
  const cache = new Map<ProbeId, ProbeResult>();
  const stats: ProbeStats = { criteria: 0, refutedByProbes: 0, noMatchingProbe: 0, survivedProbes: 0, modelUsed: 0 };
  const runs: VerifyRun[] = [];
  let model: ModelClient | undefined;
  let modelError: string | undefined;

  const getModel = (): ModelClient | undefined => {
    if (model) return model;
    if (modelError || !o.model) return undefined;
    try {
      model = typeof o.model === 'function' ? o.model() : o.model;
    } catch (e) {
      modelError = (e as Error).message;
    }
    return model;
  };

  const probeResult = async (id: ProbeId): Promise<ProbeResult> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const probe = probeById(id)!;
    o.log?.(`probe ${id}`);
    const r = await runProbe(probe, {
      baseUrl: o.baseUrl,
      chrome: o.chrome,
      auth: prepared,
      waitUntil: o.waitUntil,
      screenshotDir: join(dir, 'screenshots'),
      strictDetectors: o.strictDetectors,
    });
    const confirmed = r.findings.filter(counts).length;
    o.log?.(`  ${r.error ? `error: ${r.error}` : !r.applicable ? `not applicable${r.note ? ` (${r.note})` : ''}` : confirmed > 0 ? `${confirmed} confirmed finding${confirmed > 1 ? 's' : ''}` : r.findings.length > 0 ? 'unconfirmed or minor findings only' : 'clean'}`);
    cache.set(id, r);
    return r;
  };

  for (const f of await proofFiles(dir, o.issue)) {
    const proof = parseProof(await readFile(join(dir, f), 'utf8'));
    const results: VerifyResult[] = [];
    for (const c of proof.criteria) {
      stats.criteria++;
      o.log?.(`criterion ${c.id} ${c.text}`);
      const matched = matchProbes(c.text);
      const probeResults: ProbeResult[] = [];
      for (const p of matched) probeResults.push(await probeResult(p.id));
      const refuting = probeResults.filter((r) => r.refuted);
      if (refuting.length > 0) {
        stats.refutedByProbes++;
        const r = await refutedResult(c, refuting, dir, o.baseUrl);
        o.log?.(`  refuted by probes (0 tokens)`);
        results.push(r);
        continue;
      }
      if (matched.length === 0) stats.noMatchingProbe++;
      else stats.survivedProbes++;
      if (o.mode === 'only') {
        results.push(unrefutedResult(c, probeResults, matched.length === 0 ? 'no-probe' : 'probes-clean'));
        continue;
      }
      const m = getModel();
      if (!m) {
        results.push({ ...unrefutedResult(c, probeResults, 'no-model'), error: modelError ?? 'No model was given, so this criterion could not be tried by the agent.' });
        continue;
      }
      stats.modelUsed++;
      o.log?.(`  model: ${matched.length === 0 ? 'no matching probe' : 'survived its probes'}`);
      const r = await verifyOne(c, { ...o, model: m, dir, prepared });
      results.push({ ...r, probes: matched.map((p) => p.id) });
    }
    const file = join(dir, `verify-${proof.issue}.json`);
    const body: VerifyFile = { issue: proof.issue, title: proof.title, baseUrl: o.baseUrl, criteriaHash: criteriaHash(proof), results };
    await writeFile(file, JSON.stringify(body, null, 2));
    runs.push({ issue: proof.issue, file: slash(file), results });
  }
  return { runs, stats, ...(modelError ? { modelError } : {}) };
}

function unrefutedResult(c: Criterion, probes: ProbeResult[], outcome: 'no-probe' | 'probes-clean' | 'no-model'): VerifyResult {
  const findings = probes.flatMap((p) => p.findings).map((f) => ({ ...f }));
  const names = probes.map((p) => p.id);
  const summary =
    outcome === 'no-probe'
      ? 'No probe applies to this criterion; it needs the model.'
      : `Probes ran (${names.join(', ')}) and could not refute it; ${probes.some((p) => p.applicable) ? 'that does not show it holds' : 'none had anything to act on in this app'}.`;
  return {
    criterionId: c.id,
    criterion: c.text,
    verdict: 'inconclusive',
    outcome,
    summary,
    findings,
    actions: [],
    screenshots: [],
    steps: 0,
    usage: { input: 0, output: 0 },
    probes: names,
  };
}

async function refutedResult(c: Criterion, refuting: ProbeResult[], dir: string, baseUrl: string): Promise<VerifyResult> {
  const all: ResultFinding[] = refuting.flatMap((p) => p.findings);
  const ordered = [...refuting].sort((a, b) => Math.max(...b.findings.filter(counts).map((f) => f.severity)) - Math.max(...a.findings.filter(counts).map((f) => f.severity)));
  let repro: string | undefined;
  await mkdir(join(dir, 'repro'), { recursive: true });
  for (let i = 0; i < ordered.length; i++) {
    const p = ordered[i]!;
    const hits = p.findings.filter(counts);
    const titles = new Set(hits.map((f) => f.title));
    const file: ReproFile = {
      version: 1,
      criterionId: c.id,
      baseUrl,
      actions: p.actions,
      violations: p.violations.filter((v) => titles.has(v.title)).map(({ title, expected, actual, assertIndex }) => ({ title, expected, actual, assertIndex })),
      detectors: hits.filter((f) => f.kind !== 'violation').map((f) => ({ kind: f.kind, title: f.title })),
    };
    const path = join(dir, 'repro', i === 0 ? `${c.id}.json` : `${c.id}~${p.id}.json`);
    await writeFile(path, JSON.stringify(file, null, 2));
    if (i === 0) repro = slash(path);
  }
  const top = ordered[0]!;
  const topFinding = top.findings.filter(counts).sort((a, b) => b.severity - a.severity)[0]!;
  return {
    criterionId: c.id,
    criterion: c.text,
    verdict: 'refuted',
    outcome: 'probes',
    summary: `Refuted by the ${top.id} probe with no model: ${topFinding.title}.`,
    findings: all,
    actions: top.actions,
    screenshots: [...new Set(ordered.flatMap((p) => p.screenshots))],
    repro,
    steps: top.actions.length,
    usage: { input: 0, output: 0 },
    probes: ordered.map((p) => p.id),
  };
}

