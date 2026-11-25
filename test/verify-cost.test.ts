import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Page } from '../src/driver/index.js';
import { DEFAULT_BUDGET_TOKENS, SYSTEM_PROMPT, TOOLS, verifyCriterion } from '../src/verify/agent.js';
import { AnthropicModel, ScriptedModel, type Msg, type ScriptedStep } from '../src/verify/model.js';
import { diffSnapshots, FULL_EVERY } from '../src/verify/snapshot-diff.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** A page with no browser behind it: a long list of static lines and one counter that every click changes. */
class FakePage {
  count = 0;
  constructor(private readonly rows = 120) {}
  text(): string {
    const lines = ['- heading "Notes"', '- textbox "Note" [ref=e1]', '- button "Save" [ref=e2]'];
    for (let i = 0; i < this.rows; i++) lines.push(`- StaticText "Row ${i}: a line of the page that never changes"`);
    lines.push(`- StaticText "Saved ${this.count} times"`);
    return lines.join('\n');
  }
  async goto(): Promise<void> {}
  async reload(): Promise<void> {}
  async back(): Promise<boolean> { return false; }
  async setViewport(): Promise<void> {}
  async setOffline(): Promise<void> {}
  async snapshot(): Promise<{ text: string; refs: Map<string, number> }> { return { text: this.text(), refs: new Map() }; }
  async click(): Promise<void> { this.count++; }
  async type(): Promise<void> {}
  async press(): Promise<void> {}
  async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('scrollWidth')) return { scrollWidth: 800, innerWidth: 800 } as T;
    if (expression.includes('querySelectorAll')) return [] as T;
    return this.text() as T;
  }
  async screenshot(): Promise<Buffer> { return Buffer.from('png'); }
  async url(): Promise<string> { return 'http://app.test/'; }
  async title(): Promise<string> { return 'Notes'; }
  problems(): { console: string[]; network: string[] } { return { console: [], network: [] }; }
  async close(): Promise<void> {}
}

const asPage = (p: FakePage): Page => p as unknown as Page;
const click: ScriptedStep = { toolCalls: [{ name: 'click', input: { ref: 'e2' } }], usage: { input: 100, output: 10 } };
const conclude: ScriptedStep = { toolCalls: [{ name: 'conclude', input: { holds: true, summary: 'held' } }], usage: { input: 100, output: 10 } };

/** The text of every tool result the model was shown, in order (taken from its last request). */
function toolTexts(model: ScriptedModel): string[] {
  const last = model.requests[model.requests.length - 1]!.messages;
  return last.flatMap((m: Msg) => (m.role === 'tool' ? m.results.map((r) => r.text) : []));
}

// ------------------------------------------------------------ snapshot diff

test('diffSnapshots: identical snapshots give an empty diff', () => {
  const d = diffSnapshots('a\nb\nc', 'a\nb\nc')!;
  assert.deepEqual(d, { text: '', added: 0, removed: 0 });
});

test('diffSnapshots: shows added and removed lines with a little context and collapses the rest', () => {
  const prev = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const next = prev.replace('line 10', 'line ten').replace('line 3\n', 'line 3\nline 3b\n');
  const d = diffSnapshots(prev, next, 1)!;
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.match(d.text, /\+\|line 3b/);
  assert.match(d.text, /-\|line 10/);
  assert.match(d.text, /\+\|line ten/);
  assert.match(d.text, / \|line 9/);
  assert.doesNotMatch(d.text, /line 15/);
  assert.match(d.text, /…\|\(\d+ unchanged lines?\)/);
});

test('diffSnapshots: a whole new page is a diff as large as the page, and a huge changed region gives up', () => {
  const a = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n');
  const b = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n');
  const d = diffSnapshots(a, b)!;
  assert.equal(d.added, 30);
  assert.equal(d.removed, 30);
  assert.ok(d.text.length > b.length);
  const big = (p: string) => Array.from({ length: 2500 }, (_, i) => `${p} ${i}`).join('\n');
  assert.equal(diffSnapshots(big('x'), big('y')), undefined);
});

// ------------------------------------------------------------ diffs sent

test('after the first view a typical step sends a small diff instead of the whole snapshot', async () => {
  const page = new FakePage();
  const model = new ScriptedModel([click, click, conclude]);
  const r = await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'Saving works' }, baseUrl: 'http://app.test/' });
  assert.equal(r.outcome, 'concluded');
  const first = (model.requests[0]!.messages[0] as { text: string }).text;
  const [step1, step2] = toolTexts(model);
  assert.match(first, /Snapshot:\n- heading "Notes"/);
  assert.match(step1!, /Snapshot changes since the previous snapshot/);
  assert.match(step1!, /-\|- StaticText "Saved 0 times"/);
  assert.match(step1!, /\+\|- StaticText "Saved 1 times"/);
  assert.doesNotMatch(step1!, /Row 5:/);
  assert.ok(step1!.length * 10 < first.length, `diff ${step1!.length} chars should be under a tenth of the full ${first.length}`);
  assert.ok(step2!.length * 10 < first.length);
});

test('a full snapshot is sent on the first view, then every FULL_EVERY views, and always on request', async () => {
  const page = new FakePage();
  const clicks = Array.from({ length: FULL_EVERY + 1 }, () => click);
  const model = new ScriptedModel([...clicks, { toolCalls: [{ name: 'snapshot', input: {} }] }, click, conclude]);
  await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'Saving works' }, baseUrl: 'http://app.test/', maxSteps: 20 });
  const texts = toolTexts(model);
  const isFull = (t: string): boolean => t.includes('Snapshot:\n- heading "Notes"');
  const kinds = texts.map((t) => (isFull(t) ? 'full' : 'diff'));
  // The first view (the opening message) was full, so tool results 1-4 are diffs and the 5th is full again.
  assert.deepEqual(kinds.slice(0, FULL_EVERY), ['diff', 'diff', 'diff', 'diff', 'full']);
  assert.equal(kinds[FULL_EVERY], 'diff');
  assert.equal(kinds[FULL_EVERY + 1], 'full', 'the snapshot tool always returns the whole page');
  assert.equal(kinds[FULL_EVERY + 2], 'diff');
});

test('an unchanged page is reported as unchanged, not resent', async () => {
  const page = new FakePage();
  const model = new ScriptedModel([{ toolCalls: [{ name: 'press', input: { key: 'Tab' } }] }, conclude]);
  await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/' });
  assert.match(toolTexts(model)[0]!, /Snapshot: unchanged since the previous snapshot\./);
});

test('when the page changes completely the whole snapshot is sent instead of a longer diff', async () => {
  const page = new FakePage(10);
  let swapped = false;
  page.click = async () => {
    swapped = true;
  };
  const original = page.text.bind(page);
  page.text = () => (swapped ? Array.from({ length: 40 }, (_, i) => `- StaticText "Another page, line ${i}"`).join('\n') : original());
  const model = new ScriptedModel([click, conclude]);
  await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/' });
  const t = toolTexts(model)[0]!;
  assert.match(t, /Snapshot:\n- StaticText "Another page, line 0"/);
  assert.doesNotMatch(t, /Snapshot changes since/);
});

test('refs still resolve against the latest full snapshot when the model only saw a diff', async () => {
  const page = new FakePage();
  const model = new ScriptedModel([click, click, conclude]);
  const r = await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/' });
  assert.deepEqual(r.actions.map((a) => a.type), ['goto', 'click', 'click']);
  assert.equal(page.count, 2);
});

// ----------------------------------------------------------------- budget

test('the default budget is 20000 tokens per criterion and the run stops cleanly as inconclusive when it is exceeded', async () => {
  assert.equal(DEFAULT_BUDGET_TOKENS, 20000);
  const page = new FakePage();
  const spend = { toolCalls: [{ name: 'click', input: { ref: 'e2' } }], usage: { input: 9000, output: 500 } };
  const model = new ScriptedModel([spend, spend, spend, spend, conclude]);
  const r = await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/', maxSteps: 10 });
  assert.equal(r.budgetTokens, 20000);
  assert.equal(r.outcome, 'budget');
  assert.equal(r.steps, 3);
  assert.deepEqual(r.usage, { input: 27000, output: 1500 });
  assert.match(r.summary!, /used 28500 tokens, over the budget of 20000.*inconclusive/);
  assert.equal(r.holds, undefined, 'a run that was cut off never concludes that the criterion holds');
  // The third response was not acted on: goto plus two clicks, nothing more.
  assert.deepEqual(r.actions.map((a) => a.type), ['goto', 'click', 'click']);
  assert.equal(model.requests.length, 3);
});

test('budgetTokens overrides the default; 0 means no limit', async () => {
  const spend = { toolCalls: [{ name: 'click', input: { ref: 'e2' } }], usage: { input: 9000, output: 500 } };
  const small = await verifyCriterion({ page: asPage(new FakePage()), model: new ScriptedModel([spend, conclude]), criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/', budgetTokens: 5000 });
  assert.equal(small.outcome, 'budget');
  assert.equal(small.steps, 1);
  assert.equal(small.budgetTokens, 5000);

  const none = await verifyCriterion({ page: asPage(new FakePage()), model: new ScriptedModel([spend, spend, spend, spend, { ...conclude, usage: { input: 9000, output: 500 } }]), criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/', budgetTokens: 0, maxSteps: 10 });
  assert.equal(none.outcome, 'concluded');
  assert.equal(none.budgetTokens, 0);
  assert.equal(none.holds, true);
  assert.deepEqual(none.usage, { input: 45000, output: 2500 });
});

test('a run that stays inside its budget concludes normally', async () => {
  const r = await verifyCriterion({ page: asPage(new FakePage()), model: new ScriptedModel([click, conclude]), criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/' });
  assert.equal(r.outcome, 'concluded');
  assert.deepEqual(r.usage, { input: 200, output: 20 });
});

test('CLI: a bad --budget-tokens is refused before any model is built', () => {
  const env = { ...process.env, OKPROOF_ANTHROPIC_API_KEY: '' };
  for (const bad of ['abc', '-5', '1.5']) {
    const r = spawnSync(process.execPath, [cli, 'verify', '--url', 'http://127.0.0.1:1', '--budget-tokens', bad], { encoding: 'utf8', env });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--budget-tokens needs a whole number of tokens \(0 means no limit\)/);
  }
});

// ---------------------------------------------------------------- caching

test('the system prompt and the tool list are byte-identical on every step, with the page content last', async () => {
  const page = new FakePage();
  const model = new ScriptedModel([click, click, click, conclude]);
  await verifyCriterion({ page: asPage(page), model, criterion: { id: '1.1', text: 'x' }, baseUrl: 'http://app.test/' });
  assert.equal(model.requests.length, 4);
  const sys = model.requests.map((q) => q.system);
  const toolJson = model.requests.map((q) => JSON.stringify(q.tools));
  assert.ok(sys.every((s) => s === SYSTEM_PROMPT && Buffer.from(s).equals(Buffer.from(SYSTEM_PROMPT))));
  assert.ok(toolJson.every((t) => t === JSON.stringify(TOOLS)));
  assert.equal(new Set(toolJson).size, 1);
  // Messages only ever grow at the end, so the cached prefix of the conversation never changes.
  for (let i = 1; i < model.requests.length; i++) {
    const before = JSON.stringify(model.requests[i - 1]!.messages);
    const now = JSON.stringify(model.requests[i]!.messages.slice(0, model.requests[i - 1]!.messages.length));
    assert.equal(now, before);
  }
});

test('the request body keeps everything stable before the messages, so the API can cache it', () => {
  const client = { messages: { async create() { return { content: [], stop_reason: 'end_turn' }; } } };
  const m = new AnthropicModel({ client, apiKey: 'unused' });
  const a = m.buildRequest({ system: SYSTEM_PROMPT, tools: TOOLS, messages: [{ role: 'user', text: 'first page' }] });
  const b = m.buildRequest({ system: SYSTEM_PROMPT, tools: TOOLS, messages: [{ role: 'user', text: 'first page' }, { role: 'user', text: 'a diff of the second page' }] });
  const { messages: ma, ...restA } = a;
  const { messages: mb, ...restB } = b;
  assert.equal(JSON.stringify(restA), JSON.stringify(restB));
  assert.ok(Object.keys(a).indexOf('system') < Object.keys(a).indexOf('messages'));
  assert.ok(Object.keys(a).indexOf('tools') < Object.keys(a).indexOf('messages'));
  assert.equal(Object.keys(a).at(-1), 'messages');
  assert.equal((ma as unknown[]).length, 1);
  assert.equal((mb as unknown[]).length, 2);
});

test('the model id stays user-configurable and the default is unchanged', () => {
  const client = { messages: { async create() { return { content: [], stop_reason: 'end_turn' }; } } };
  assert.equal(new AnthropicModel({ client, apiKey: 'x' }).buildRequest({ system: '', tools: [], messages: [] }).model, 'claude-opus-5-5');
  assert.equal(new AnthropicModel({ client, apiKey: 'x', model: 'a-smaller-model' }).buildRequest({ system: '', tools: [], messages: [] }).model, 'a-smaller-model');
});
