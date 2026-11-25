// Replays recorded actions with no model. This is what turns a model's claim
// into evidence: a violation only counts if its assertion fails again here.

import type { Page } from '../driver/index.js';
import { execute, isAssertion, type Action } from './actions.js';
import { Detectors, type Finding } from './detectors.js';

export interface StepResult {
  index: number;
  action: Action;
  ran: boolean;
  error?: string;
  /** Assertions only. */
  passed?: boolean;
  message?: string;
}

export interface ReplayResult {
  steps: StepResult[];
  findings: Finding[];
  /** Index of the first action that could not run (the replay stops there), if any. */
  abortedAt?: number;
  abortReason?: string;
  /** True when the replay stopped because an action tried to leave the app origin (a crafted or stale repro). */
  refusedOrigin?: boolean;
  /** Assertion index to whether it failed, for every assertion that ran. */
  assertionFailed: Map<number, boolean>;
}

export interface ReplayOptions {
  baseUrl: string;
  checkLinks?: boolean;
  /** Called right after an assertion fails, e.g. to take a screenshot. */
  onAssertionFailed?: (index: number, page: Page) => Promise<void>;
}

export async function replay(actions: Action[], page: Page, opts: ReplayOptions): Promise<ReplayResult> {
  const detectors = new Detectors(page, { baseUrl: opts.baseUrl, checkLinks: opts.checkLinks });
  const result: ReplayResult = { steps: [], findings: [], assertionFailed: new Map() };
  const appOrigin = new URL(opts.baseUrl).origin;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    if (action.type === 'goto') {
      // A repro file is data from the repository: it must not steer the replay to another host.
      let target: string;
      try {
        target = new URL(action.url, opts.baseUrl).origin;
      } catch {
        target = '';
      }
      if (target !== appOrigin) {
        const error = `goto ${JSON.stringify(action.url)} refused: it leaves the app origin ${appOrigin}`;
        result.steps.push({ index: i, action, ran: false, error });
        result.abortedAt = i;
        result.abortReason = error;
        result.refusedOrigin = true;
        break;
      }
    }
    const r = await execute(page, action, { baseUrl: opts.baseUrl, resolveByLabel: true });
    result.steps.push({ index: i, action, ran: r.ran, error: r.error, passed: r.passed, message: r.message });
    if (!r.ran) {
      result.abortedAt = i;
      result.abortReason = r.error;
      break;
    }
    if (action.type === 'offline') detectors.offline = action.on;
    if (isAssertion(action)) {
      result.assertionFailed.set(i, r.passed === false);
      if (r.passed === false) await opts.onAssertionFailed?.(i, page).catch(() => undefined);
    }
    result.findings.push(...(await detectors.run(i)));
  }
  return result;
}
