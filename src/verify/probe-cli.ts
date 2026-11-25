// The probe-aware half of `okproof verify`: prints results and picks the exit code.
import type { WaitUntil } from '../driver/index.js';
import type { AuthOptions } from './auth.js';
import { AnthropicModel, MISSING_KEY_MESSAGE, type Effort, type ModelClient } from './model.js';
import { savingsLine, verifyWithProbes } from './probe-run.js';

export interface ProbesCliOptions {
  dir: string;
  issue?: string;
  url: string;
  auth: AuthOptions;
  waitUntil?: WaitUntil;
  /** 'only' never makes a model, so no key is read. */
  mode: 'first' | 'only';
  model?: string;
  effort?: Effort;
  maxSteps: number;
  strictDetectors: boolean;
  /** Per-criterion token budget for the model part (0: none). */
  budgetTokens?: number;
  /** Test hook: stands in for the Anthropic adapter. */
  makeModel?: () => ModelClient;
  log?: (line: string) => void;
}

/** Exit codes: 1 a criterion was refuted, 2 a criterion needed a model and none was available, else 0. */
export async function runProbesCli(o: ProbesCliOptions): Promise<number> {
  const out = o.log ?? ((l: string) => console.log(l));
  const makeModel = o.makeModel ?? ((): ModelClient => new AnthropicModel({ model: o.model, effort: o.effort }));
  const { runs, stats, modelError } = await verifyWithProbes({
    mode: o.mode,
    dir: o.dir,
    issue: o.issue,
    baseUrl: o.url,
    chrome: process.env.OKPROOF_CHROME,
    waitUntil: o.waitUntil,
    maxSteps: o.maxSteps,
    strictDetectors: o.strictDetectors,
    budgetTokens: o.budgetTokens,
    ...o.auth,
    ...(o.mode === 'first' ? { model: makeModel } : {}),
    log: out,
  });
  let refuted = false;
  for (const run of runs) {
    for (const r of run.results) {
      out(`${r.criterionId}: ${r.verdict}${r.repro ? ` (repro: ${r.repro})` : ''}${r.outcome === 'probes' ? ' [probes, 0 tokens]' : ''}`);
      for (const x of r.findings) out(`  ${x.confirmed ? 'confirmed' : 'unconfirmed'} [${x.severity}] ${x.title}`);
      if (r.verdict === 'inconclusive' && r.summary) out(`  ${r.summary}`);
      refuted ||= r.verdict === 'refuted';
    }
  }
  out(savingsLine(stats, o.mode));
  if (refuted) return 1;
  if (modelError) {
    console.error(modelError === MISSING_KEY_MESSAGE ? `${modelError}\nTo re-run saved repro scripts without a model, add --replay-only. To run only the probes, with no model, add --probes-only.` : modelError);
    return 2;
  }
  return 0;
}
