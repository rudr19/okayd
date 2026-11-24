// The adversarial QA loop. The model only acts through tools; everything it
// does is recorded as plain actions, and its claims are checked later by replay.

import type { Page } from '../driver/index.js';
import { execute, isAssertion, normalizeUrl, parseSnapshotRefs, type Action } from './actions.js';
import { Detectors, type Finding } from './detectors.js';
import type { ModelClient, Msg, ToolCall, ToolDef, ToolResultPart } from './model.js';

/** Stable across every call and every criterion, so it caches well. */
export const SYSTEM_PROMPT = `You are an independent, adversarial QA engineer. You did NOT write this code and you have no stake in it passing. Your job is to try to prove that one acceptance criterion is FALSE in the running web app, using only the tools you are given.

How to work:
- You see the app only through accessibility snapshots. Interactive elements carry refs like [ref=e3]. Refs are valid only until the next snapshot; always use refs from the latest snapshot.
- Do not just walk the happy path. Attack the criterion with realistic abuse: other roles or accounts if the UI shows them, invalid and edge-case input, empty input, very long input, unicode and emoji, double submit, reloading in the middle of a flow, back navigation, keyboard-only use, a 375px wide viewport, and going offline.
- Check that state really persisted: after an action that claims success, reload and look again.
- Stay inside the app's own origin. Never invent data you did not enter yourself.

Reporting:
- If you believe the criterion is broken, call report_violation with a short title, what was expected and what actually happened. You must then immediately call one assertion tool (assert_text, assert_url or assert_no_problems). The assertion states what SHOULD be true, so it must currently FAIL, because it captures the broken behaviour. It is replayed later without you; a violation whose assertion does not fail again is discarded, so only report what you can show.
- When you are satisfied that you tried hard and the criterion holds, call conclude with holds=true and a one-sentence summary. If you ran out of ideas but found nothing, that is a pass: conclude.
- Automatic detectors also report console errors, exceptions, failed requests, unnamed controls and overflow after every action. You do not need to report those yourself.

Be efficient: every tool call costs money. Prefer a few sharp attacks over many shallow ones.`;

const obj = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  { name: 'goto', description: 'Navigate to a URL on the app (absolute, or a path like /settings).', inputSchema: obj({ url: str('URL or path on the app origin') }) },
  { name: 'click', description: 'Click an element by ref from the latest snapshot.', inputSchema: obj({ ref: str('ref such as e3') }) },
  { name: 'type', description: 'Focus an element by ref and insert text.', inputSchema: obj({ ref: str('ref such as e3'), text: str('text to insert') }) },
  { name: 'press', description: 'Press a key: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.', inputSchema: obj({ key: str('key name') }) },
  { name: 'set_viewport', description: 'Resize the viewport, e.g. 375x812 for a phone.', inputSchema: obj({ width: { type: 'integer' }, height: { type: 'integer' } }) },
  { name: 'reload', description: 'Reload the current page.', inputSchema: obj({}) },
  { name: 'back', description: 'Go back one history entry.', inputSchema: obj({}) },
  { name: 'set_offline', description: 'Turn network offline emulation on or off.', inputSchema: obj({ on: { type: 'boolean' } }) },
  { name: 'snapshot', description: 'Take a fresh accessibility snapshot of the page.', inputSchema: obj({}) },
  { name: 'screenshot', description: 'Take a screenshot. Use sparingly; only when the snapshot cannot show what you need (layout, colour).', inputSchema: obj({}) },
  { name: 'assert_text', description: 'Assert that visible text (including form field values) is present or absent. Used after report_violation: it must currently fail.', inputSchema: obj({ text: str('text to look for'), present: { type: 'boolean' } }) },
  { name: 'assert_url', description: 'Assert the current URL includes a substring. Used after report_violation: it must currently fail.', inputSchema: obj({ includes: str('substring') }) },
  { name: 'assert_no_problems', description: 'Assert the page has logged no console errors and no failed requests. Used after report_violation: it must currently fail.', inputSchema: obj({}) },
  {
    name: 'report_violation',
    description: 'Claim the criterion is broken. Immediately follow with an assertion tool whose assertion currently fails.',
    inputSchema: obj({ title: str('short title'), expected: str('what the criterion requires'), actual: str('what actually happened') }),
  },
  { name: 'conclude', description: 'Finish. holds=true means you could not break the criterion.', inputSchema: obj({ holds: { type: 'boolean' }, summary: str('one sentence') }) },
];

export interface Violation {
  title: string;
  expected: string;
  actual: string;
  /** Index into `actions` of the assertion that failed live. */
  assertIndex: number;
  liveMessage: string;
}

export type AgentOutcome = 'concluded' | 'max-steps' | 'budget' | 'refusal' | 'max-tokens' | 'no-tool' | 'error';

export interface AgentResult {
  outcome: AgentOutcome;
  /** The model's conclusion, when it concluded. */
  holds?: boolean;
  summary?: string;
  error?: string;
  actions: Action[];
  violations: Violation[];
  /** Detector findings plus unconfirmed violation claims. Nothing here is confirmed yet. */
  findings: Finding[];
  steps: number;
  usage: { input: number; output: number };
}

export interface VerifyCriterionOptions {
  page: Page;
  model: ModelClient;
  criterion: { id: string; text: string };
  baseUrl: string;
  maxSteps?: number;
  /** Stop once input+output tokens exceed this. */
  budgetTokens?: number;
  checkLinks?: boolean;
}

const MAX_SNAPSHOT_CHARS = 12000;

export async function verifyCriterion(opts: VerifyCriterionOptions): Promise<AgentResult> {
  const { page, model, criterion, baseUrl } = opts;
  const maxSteps = opts.maxSteps ?? 15;
  const detectors = new Detectors(page, { baseUrl, checkLinks: opts.checkLinks });
  const origin = new URL(baseUrl).origin;
  const result: AgentResult = { outcome: 'max-steps', actions: [], violations: [], findings: [], steps: 0, usage: { input: 0, output: 0 } };
  let lastSnap = '';
  let pending: { title: string; expected: string; actual: string } | undefined;

  const observe = async (): Promise<string> => {
    const snap = (await page.snapshot()).text;
    lastSnap = snap;
    const found = await detectors.run(Math.max(0, result.actions.length - 1), snap);
    result.findings.push(...found);
    const url = await page.url().catch(() => '?');
    const lines = [`URL: ${url}`];
    if (found.length > 0) lines.push('Automatic detector findings:', ...found.map((f) => `- [severity ${f.severity}] ${f.title}`));
    const body = snap.length > MAX_SNAPSHOT_CHARS ? snap.slice(0, MAX_SNAPSHOT_CHARS) + '\n… (snapshot truncated)' : snap;
    lines.push('Snapshot:', body || '(empty page)');
    return lines.join('\n');
  };

  const record = (a: Action): void => {
    result.actions.push(a);
  };

  const first = await execute(page, { type: 'goto', url: normalizeUrl(baseUrl, baseUrl) }, { baseUrl, resolveByLabel: false });
  if (!first.ran) return { ...result, outcome: 'error', error: first.error };
  record({ type: 'goto', url: normalizeUrl(baseUrl, baseUrl) });

  const messages: Msg[] = [
    {
      role: 'user',
      text: `Acceptance criterion ${criterion.id}: ${criterion.text}\n\nApp: ${baseUrl}\nTry to prove this criterion false.\n\n${await observe()}`,
    },
  ];

  const finishPending = (reason: string): void => {
    if (!pending) return;
    result.findings.push({
      kind: 'violation',
      severity: 4,
      title: pending.title,
      detail: `expected: ${pending.expected}\nactual: ${pending.actual}\n(${reason})`,
      url: '',
      step: Math.max(0, result.actions.length - 1),
    });
    pending = undefined;
  };

  const runTool = async (call: ToolCall): Promise<ToolResultPart | 'conclude'> => {
    const input = call.input;
    const part = (text: string, isError = false): ToolResultPart => ({ id: call.id, text, isError: isError || undefined });
    const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');

    switch (call.name) {
      case 'snapshot':
        return part(await observe());
      case 'screenshot': {
        const png = await page.screenshot();
        return { id: call.id, text: 'Screenshot attached.', imageBase64: png.toString('base64') };
      }
      case 'conclude':
        result.holds = input.holds === true;
        result.summary = s('summary');
        return 'conclude';
      case 'report_violation':
        if (!s('title') || !s('expected') || !s('actual')) return part('report_violation needs title, expected and actual.', true);
        finishPending('no assertion was supplied before the next violation report');
        pending = { title: s('title'), expected: s('expected'), actual: s('actual') };
        return part('Violation noted. Now call assert_text, assert_url or assert_no_problems with an assertion of what SHOULD be true that currently FAILS. It will be replayed without you to confirm.');
    }

    let action: Action | undefined;
    switch (call.name) {
      case 'goto': {
        let url: string;
        try { url = normalizeUrl(s('url'), baseUrl); } catch { return part(`Not a valid URL: ${s('url')}`, true); }
        if (new URL(url, baseUrl).origin !== origin) return part(`Stay on the app origin (${origin}).`, true);
        action = { type: 'goto', url };
        break;
      }
      case 'click':
      case 'type': {
        const t = parseSnapshotRefs(lastSnap).find((e) => e.ref === s('ref'));
        if (!t) return part(`Unknown ref ${s('ref')}. Use a ref from the latest snapshot.`, true);
        const target = { role: t.role, name: t.name, nth: t.nth };
        action = call.name === 'click' ? { type: 'click', ref: t.ref, ...target } : { type: 'type', ref: t.ref, text: s('text'), ...target };
        break;
      }
      case 'press': action = { type: 'press', key: s('key') }; break;
      case 'set_viewport': {
        const w = Number(input.width), h = Number(input.height);
        if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000)) return part('Viewport width and height must be between 200 and 4000.', true);
        action = { type: 'setViewport', width: Math.round(w), height: Math.round(h) };
        break;
      }
      case 'reload': action = { type: 'reload' }; break;
      case 'back': action = { type: 'back' }; break;
      case 'set_offline': action = { type: 'offline', on: input.on === true }; break;
      case 'assert_text': action = { type: 'assertText', text: s('text'), present: input.present !== false }; break;
      case 'assert_url': action = { type: 'assertUrl', includes: s('includes') }; break;
      case 'assert_no_problems': action = { type: 'assertNoProblems' }; break;
      default:
        return part(`Unknown tool ${call.name}.`, true);
    }

    const r = await execute(page, action, { baseUrl, resolveByLabel: false });
    if (!r.ran) return part(`ERROR: ${r.error}\n${await observe()}`, true);
    if (action.type === 'offline') detectors.offline = action.on;

    if (isAssertion(action)) {
      if (!pending) return part(r.passed ? 'Assertion passed (probe only, not recorded).' : `Assertion failed (probe only, not recorded): ${r.message}. If this is a bug, call report_violation first.`);
      const claim = pending;
      if (r.passed) {
        finishPending('its assertion passed when run live, so the claim was not demonstrated');
        return part('That assertion PASSED, so the violation is not demonstrated and was dropped. Keep exploring or conclude.');
      }
      record(action);
      result.violations.push({ ...claim, assertIndex: result.actions.length - 1, liveMessage: r.message ?? '' });
      result.findings.push({
        kind: 'violation',
        severity: 4,
        title: claim.title,
        detail: `expected: ${claim.expected}\nactual: ${claim.actual}\nassertion failed: ${r.message}`,
        url: await page.url().catch(() => ''),
        step: result.actions.length - 1,
      });
      pending = undefined;
      return part(`Violation recorded; its assertion failed as required (${r.message}). It will be replayed independently. Keep attacking other angles or conclude.`);
    }

    record(action);
    return part(`OK\n${await observe()}`);
  };

  let idleTurns = 0;
  for (let turn = 0; turn < maxSteps; turn++) {
    result.steps = turn + 1;
    let res;
    try {
      res = await model.next({ system: SYSTEM_PROMPT, messages, tools: TOOLS });
    } catch (e) {
      result.outcome = 'error';
      result.error = (e as Error).message;
      break;
    }
    result.usage.input += res.usage?.input ?? 0;
    result.usage.output += res.usage?.output ?? 0;
    if (res.stop === 'refusal' || res.stop === 'max_tokens') {
      result.outcome = res.stop === 'refusal' ? 'refusal' : 'max-tokens';
      break;
    }
    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
    if (opts.budgetTokens !== undefined && result.usage.input + result.usage.output > opts.budgetTokens) {
      result.outcome = 'budget';
      break;
    }
    if (res.toolCalls.length === 0) {
      // The model must act through tools; nudge once, then give up.
      if (idleTurns++ >= 1) { result.outcome = 'no-tool'; break; }
      messages.push({ role: 'user', text: 'Use a tool to continue, or call conclude if you are done.' });
      continue;
    }
    idleTurns = 0;
    const results: ToolResultPart[] = [];
    let concluded = false;
    for (const call of res.toolCalls) {
      if (concluded) {
        results.push({ id: call.id, text: 'Already concluded.', isError: true });
        continue;
      }
      let out: ToolResultPart | 'conclude';
      try {
        out = await runTool(call);
      } catch (e) {
        out = { id: call.id, text: `Tool failed: ${(e as Error).message}`, isError: true };
      }
      if (out === 'conclude') {
        concluded = true;
        results.push({ id: call.id, text: 'Concluded.' });
      } else {
        results.push(out);
      }
    }
    messages.push({ role: 'tool', results });
    if (concluded) {
      result.outcome = 'concluded';
      break;
    }
  }
  finishPending('the run ended before an assertion was supplied');
  return result;
}
