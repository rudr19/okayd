// Orchestration: for each criterion run the agent, replay its findings with no
// model, and write the evidence. Only what replays counts as confirmed.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProof, type Criterion } from '../proof.js';
import { Browser } from '../driver/index.js';
import { verifyCriterion, type AgentResult } from './agent.js';
import { attributeFinding } from './attribution.js';
import { prepareAuth, type AuthOptions, type PreparedAuth } from './auth.js';
import { findingKey, REFUTE_SEVERITY } from './detectors.js';
import { criteriaHash } from './ledger.js';
import type { ModelClient } from './model.js';
import { replay, type ReplayResult } from './replay.js';
import type { ReproFile, ResultFinding, VerifyFile, VerifyResult } from './types.js';

export interface VerifyOptions extends AuthOptions {
  /** Folder holding proof files. Default ".okproof". */
  dir?: string;
  /** Only this issue's proof file. */
  issue?: string;
  baseUrl: string;
  model: ModelClient;
  /** Path to a Chrome/Chromium/Edge binary. Default: auto-detect. */
  chrome?: string;
  maxSteps?: number;
  budgetTokens?: number;
  checkLinks?: boolean;
  /** Count every detector finding against the criterion, wherever it came from (the 0.1.0 behaviour). */
  strictDetectors?: boolean;
  /** Set by verify() so every criterion shares one validated auth setup. */
  prepared?: PreparedAuth;
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface VerifyRun {
  issue: string;
  file: string;
  results: VerifyResult[];
}

const slash = (p: string): string => p.replace(/\\/g, '/');

async function proofFiles(dir: string, issue?: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('ledger-') && (!issue || f === `${issue}.md`));
}

/** Replays actions in a fresh browser, so cookies and storage from the agent run cannot leak in. */
async function freshReplay(
  actions: ReproFile['actions'],
  o: { baseUrl: string; chrome?: string; checkLinks?: boolean; screenshotDir?: string; screenshotPrefix?: string; auth?: PreparedAuth },
): Promise<{ result: ReplayResult; screenshots: string[] }> {
  const browser = await Browser.launch({ executablePath: o.chrome });
  const screenshots: string[] = [];
  try {
    const page = await browser.newPage();
    await o.auth?.apply(page, o.baseUrl);
    const result = await replay(actions, page, {
      baseUrl: o.baseUrl,
      checkLinks: o.checkLinks,
      onAssertionFailed: async (index, p) => {
        if (!o.screenshotDir) return;
        await mkdir(o.screenshotDir, { recursive: true });
        const file = join(o.screenshotDir, `${o.screenshotPrefix}-${index}.png`);
        await writeFile(file, await p.screenshot());
        screenshots.push(slash(file));
      },
    });
    return { result, screenshots };
  } finally {
    await browser.close();
  }
}

export async function verifyOne(criterion: Criterion, o: VerifyOptions & { dir: string }): Promise<VerifyResult> {
  const auth = o.prepared ?? (await prepareAuth(o));
  const browser = await Browser.launch({ executablePath: o.chrome });
  let agent: AgentResult;
  try {
    const page = await browser.newPage();
    await auth.apply(page, o.baseUrl);
    agent = await verifyCriterion({
      page,
      model: o.model,
      criterion: { id: criterion.id, text: criterion.text },
      baseUrl: o.baseUrl,
      maxSteps: o.maxSteps,
      budgetTokens: o.budgetTokens,
      checkLinks: o.checkLinks,
    });
  } finally {
    await browser.close();
  }

  const findings: ResultFinding[] = [];
  let screenshots: string[] = [];
  let repro: string | undefined;

  if (agent.findings.length > 0) {
    const fr = await freshReplay(agent.actions, {
      baseUrl: o.baseUrl,
      chrome: o.chrome,
      checkLinks: o.checkLinks,
      auth,
      screenshotDir: join(o.dir, 'screenshots'),
      screenshotPrefix: criterion.id,
    });
    screenshots = fr.screenshots;
    const replayed = new Set(fr.result.findings.map(findingKey));
    for (const f of agent.findings) {
      const confirmed =
        f.kind === 'violation'
          ? agent.violations.some((v) => v.assertIndex === f.step && v.title === f.title && fr.result.assertionFailed.get(v.assertIndex) === true)
          : replayed.has(findingKey(f));
      findings.push({ ...attributeFinding(f, { baseUrl: o.baseUrl, strict: o.strictDetectors }), confirmed });
    }
    const counts = (f: ResultFinding): boolean => f.confirmed && !f.downgraded;
    if (findings.some(counts)) {
      const confirmedTitles = new Set(findings.filter(counts).map((f) => f.title));
      const file: ReproFile = {
        version: 1,
        criterionId: criterion.id,
        baseUrl: o.baseUrl,
        ...(o.checkLinks ? { checkLinks: true } : {}),
        actions: agent.actions,
        violations: agent.violations.filter((v) => confirmedTitles.has(v.title)).map(({ title, expected, actual, assertIndex }) => ({ title, expected, actual, assertIndex })),
        detectors: findings.filter((f) => counts(f) && f.kind !== 'violation').map((f) => ({ kind: f.kind, title: f.title })),
      };
      const path = join(o.dir, 'repro', `${criterion.id}.json`);
      await mkdir(join(o.dir, 'repro'), { recursive: true });
      await writeFile(path, JSON.stringify(file, null, 2));
      repro = slash(path);
    }
  }

  const refuted = findings.some((f) => f.confirmed && f.severity >= REFUTE_SEVERITY);
  const verdict = refuted ? 'refuted' : agent.outcome === 'concluded' && agent.holds ? 'held' : 'inconclusive';
  return {
    criterionId: criterion.id,
    criterion: criterion.text,
    verdict,
    outcome: agent.outcome,
    summary: agent.summary,
    error: agent.error,
    findings,
    actions: agent.actions,
    screenshots,
    repro,
    steps: agent.steps,
    usage: agent.usage,
  };
}

export async function verify(o: VerifyOptions): Promise<VerifyRun[]> {
  const dir = o.dir ?? '.okproof';
  const runs: VerifyRun[] = [];
  const prepared = await prepareAuth(o);
  for (const f of await proofFiles(dir, o.issue)) {
    const proof = parseProof(await readFile(join(dir, f), 'utf8'));
    const results: VerifyResult[] = [];
    for (const c of proof.criteria) {
      o.log?.(`verifying ${c.id} ${c.text}`);
      const r = await verifyOne(c, { ...o, dir, prepared });
      o.log?.(`  ${r.verdict}${r.findings.length ? ` (${r.findings.filter((x) => x.confirmed).length} confirmed, ${r.findings.filter((x) => !x.confirmed).length} unconfirmed)` : ''}`);
      results.push(r);
    }
    const file = join(dir, `verify-${proof.issue}.json`);
    const body: VerifyFile = { issue: proof.issue, title: proof.title, baseUrl: o.baseUrl, criteriaHash: criteriaHash(proof), results };
    await writeFile(file, JSON.stringify(body, null, 2));
    runs.push({ issue: proof.issue, file: slash(file), results });
  }
  return runs;
}

export interface ReplayOnlyResult {
  criterionId: string;
  /** True when the bug is still there. */
  reproduced: boolean;
  lines: string[];
}

/** Re-runs saved repro scripts with no model. Free, so it is safe in CI. */
export async function replayOnly(o: { dir?: string; issue?: string; baseUrl?: string; chrome?: string } & AuthOptions): Promise<ReplayOnlyResult[]> {
  const dir = o.dir ?? '.okproof';
  const auth = await prepareAuth(o);
  let names: string[];
  try {
    names = (await readdir(join(dir, 'repro'))).filter((n) => n.endsWith('.json') && (!o.issue || n.startsWith(`${o.issue}.`)));
  } catch {
    names = [];
  }
  const out: ReplayOnlyResult[] = [];
  for (const name of names) {
    const repro = JSON.parse(await readFile(join(dir, 'repro', name), 'utf8')) as ReproFile;
    const { result } = await freshReplay(repro.actions, { baseUrl: o.baseUrl ?? repro.baseUrl, chrome: o.chrome, checkLinks: repro.checkLinks, auth });
    const lines: string[] = [];
    let reproduced = false;
    for (const v of repro.violations) {
      if (result.assertionFailed.get(v.assertIndex) === true) {
        reproduced = true;
        lines.push(`still failing: ${v.title}`);
      } else {
        lines.push(`no longer failing: ${v.title}`);
      }
    }
    const replayed = new Set(result.findings.map(findingKey));
    for (const d of repro.detectors) {
      if (replayed.has(findingKey(d))) {
        reproduced = true;
        lines.push(`still detected: ${d.title}`);
      } else {
        lines.push(`no longer detected: ${d.title}`);
      }
    }
    if (result.abortedAt !== undefined) lines.push(`replay stopped at step ${result.abortedAt + 1}: ${result.abortReason}`);
    out.push({ criterionId: repro.criterionId, reproduced, lines });
  }
  return out;
}
