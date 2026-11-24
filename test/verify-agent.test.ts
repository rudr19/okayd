import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src/driver/index.js';
import { finalize } from '../src/finalize.js';
import { ScriptedModel, type ScriptedStep } from '../src/verify/model.js';
import { verifyCriterion } from '../src/verify/agent.js';
import { verify } from '../src/verify/run.js';
import type { ReproFile, VerifyFile } from '../src/verify/types.js';
import { refOf, skip, startApp } from './verify-fixture.js';

const PROOF = '## #7 Notes\n- [ ] A saved note is still there after reloading the page\n';

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-verify-'));
  await writeFile(join(dir, '7.md'), PROOF);
  return dir;
}

const call = (name: string, input: Record<string, unknown> = {}): ScriptedStep => ({ toolCalls: [{ name, input }] });

/** The attack a good QA engineer would run on the Notes page. */
function saveThenReload(finish: ScriptedStep[]): ScriptedStep[] {
  return [
    (req) => ({ toolCalls: [{ name: 'type', input: { ref: refOf(req.messages, 'textbox', 'Note'), text: 'hello' } }] }),
    (req) => ({ toolCalls: [{ name: 'click', input: { ref: refOf(req.messages, 'button', 'Save') } }] }),
    call('reload'),
    ...finish,
  ];
}

test('a real bug is refuted, confirmed by replay, saved as a repro, and fails the ledger', { skip, timeout: 120000 }, async () => {
  const app = await startApp({ persist: false });
  const dir = await workdir();
  try {
    const model = new ScriptedModel(
      saveThenReload([
        call('report_violation', { title: 'Saved note is lost on reload', expected: 'the note is still shown after reload', actual: 'Stored note is empty after reload' }),
        call('assert_text', { text: 'Stored note: hello', present: true }),
        call('conclude', { holds: false, summary: 'note is not persisted' }),
      ]),
    );
    const runs = await verify({ dir, baseUrl: app.url, model, maxSteps: 10 });
    const [r] = runs[0]!.results;
    assert.equal(r!.criterionId, '7.1');
    assert.equal(r!.verdict, 'refuted');
    const violation = r!.findings.find((f) => f.kind === 'violation')!;
    assert.equal(violation.confirmed, true);
    assert.equal(violation.title, 'Saved note is lost on reload');

    // The model saw a stable system prompt and the real snapshot, and never got a free pass.
    assert.match(model.requests[0]!.system, /adversarial QA engineer/);
    assert.ok(model.requests.every((q) => q.system === model.requests[0]!.system), 'system prompt must be stable for caching');

    // Evidence on disk.
    const verifyFile = JSON.parse(await readFile(join(dir, 'verify-7.json'), 'utf8')) as VerifyFile;
    assert.equal(verifyFile.results[0]!.verdict, 'refuted');
    const reproPath = join(dir, 'repro', '7.1.json');
    const repro = JSON.parse(await readFile(reproPath, 'utf8')) as ReproFile;
    assert.equal(repro.violations.length, 1);
    assert.equal(repro.actions[repro.violations[0]!.assertIndex]!.type, 'assertText');
    assert.deepEqual(repro.actions.map((a) => a.type), ['goto', 'type', 'click', 'reload', 'assertText']);
    assert.ok(repro.actions.some((a) => a.type === 'click' && a.role === 'button' && a.name === 'Save'));
    assert.equal(r!.screenshots.length, 1);
    assert.ok(existsSync(r!.screenshots[0]!));

    // A claiming test that passed does not rescue the criterion.
    const { ledgers } = await finalize([{ title: 'persists [okproof:7.1]', status: 'passed' }], { dir, github: false });
    const entry = ledgers[0]!.entries[0]!;
    assert.equal(entry.verdict, 'failed');
    assert.equal(ledgers[0]!.proven, false);
    const evidence = entry.tests.map((t) => t.evidence).join('\n');
    assert.match(evidence, /refuted by verifier: Saved note is lost on reload \(repro: .*repro\/7\.1\.json\)/);
    assert.match(await readFile(join(dir, 'ledger-7.md'), 'utf8'), /FAILED \| .*refuted by verifier/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hallucination guard: a violation that does not reproduce is unconfirmed and does not fail the criterion', { skip, timeout: 120000 }, async () => {
  const app = await startApp({ persist: false });
  const dir = await workdir();
  try {
    // /flaky says "loading" on the first request only, so the claim holds live but not on replay.
    const model = new ScriptedModel([
      call('goto', { url: '/flaky' }),
      call('report_violation', { title: 'Page never becomes ready', expected: 'page says ready', actual: 'page says loading' }),
      call('assert_text', { text: 'ready', present: true }),
      call('conclude', { holds: true, summary: 'nothing else found' }),
    ]);
    const runs = await verify({ dir, baseUrl: app.url, model, maxSteps: 10 });
    const r = runs[0]!.results[0]!;
    const claim = r.findings.find((f) => f.kind === 'violation')!;
    assert.equal(claim.confirmed, false);
    assert.notEqual(r.verdict, 'refuted');
    assert.equal(r.verdict, 'held');
    assert.equal(r.repro, undefined);
    assert.equal(existsSync(join(dir, 'repro', '7.1.json')), false);

    const { ledgers } = await finalize([], { dir, github: false });
    assert.equal(ledgers[0]!.entries[0]!.verdict, 'untested', 'unconfirmed claims never fail a criterion');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an assertion that passes live drops the claim; a probe outside a claim is not recorded', { skip, timeout: 60000 }, async () => {
  const app = await startApp({ persist: false });
  const browser = await Browser.launch();
  try {
    const model = new ScriptedModel([
      call('assert_text', { text: 'Notes', present: true }),
      call('report_violation', { title: 'No heading', expected: 'a heading', actual: 'none' }),
      call('assert_text', { text: 'Notes', present: true }),
      call('conclude', { holds: true, summary: 'fine' }),
    ]);
    const r = await verifyCriterion({ page: await browser.newPage(), model, criterion: { id: '7.1', text: 'x' }, baseUrl: app.url });
    assert.equal(r.outcome, 'concluded');
    assert.equal(r.holds, true);
    assert.deepEqual(r.actions.map((a) => a.type), ['goto']);
    assert.equal(r.violations.length, 0);
    assert.equal(r.findings.filter((f) => f.kind === 'violation').length, 1, 'kept as an unconfirmed finding');
  } finally {
    await browser.close();
    await app.close();
  }
});

test('refusal, max_tokens, offsite goto and step limit end cleanly', { skip, timeout: 60000 }, async () => {
  const app = await startApp({ persist: false });
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    const refused = await verifyCriterion({ page, model: new ScriptedModel([{ stop: 'refusal' }]), criterion: { id: '7.1', text: 'x' }, baseUrl: app.url });
    assert.equal(refused.outcome, 'refusal');
    const cut = await verifyCriterion({ page, model: new ScriptedModel([{ stop: 'max_tokens' }]), criterion: { id: '7.1', text: 'x' }, baseUrl: app.url });
    assert.equal(cut.outcome, 'max-tokens');

    const model = new ScriptedModel([call('goto', { url: 'http://example.com/' }), call('reload'), call('reload')]);
    const limited = await verifyCriterion({ page, model, criterion: { id: '7.1', text: 'x' }, baseUrl: app.url, maxSteps: 3 });
    assert.equal(limited.outcome, 'max-steps');
    assert.deepEqual(limited.actions.map((a) => a.type), ['goto', 'reload', 'reload'], 'the off-origin goto was refused, not run');
    const second = model.requests[1]!.messages.at(-1)!;
    assert.equal(second.role, 'tool');
    assert.match(second.role === 'tool' ? second.results[0]!.text : '', /Stay on the app origin/);

    const budget = await verifyCriterion({
      page,
      model: new ScriptedModel([{ toolCalls: [{ name: 'reload', input: {} }], usage: { input: 900, output: 200 } }]),
      criterion: { id: '7.1', text: 'x' },
      baseUrl: app.url,
      budgetTokens: 1000,
    });
    assert.equal(budget.outcome, 'budget');
  } finally {
    await browser.close();
    await app.close();
  }
});

test('finalize leaves the ledger alone when there is no verifier file, and ignores non-refuted results', async () => {
  const dir = await workdir();
  try {
    let { ledgers } = await finalize([{ title: 'a [okproof:7.1]', status: 'passed' }], { dir, github: false });
    assert.equal(ledgers[0]!.proven, true);
    const file: VerifyFile = {
      issue: '7',
      title: 'Notes',
      baseUrl: 'http://x',
      results: [{ criterionId: '7.1', criterion: 'x', verdict: 'held', outcome: 'concluded', findings: [], actions: [], screenshots: [], steps: 1, usage: { input: 0, output: 0 } }],
    };
    await writeFile(join(dir, 'verify-7.json'), JSON.stringify(file));
    ({ ledgers } = await finalize([{ title: 'a [okproof:7.1]', status: 'passed' }], { dir, github: false }));
    assert.equal(ledgers[0]!.proven, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
