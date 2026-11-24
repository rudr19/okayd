import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLedger, finalize, parseCTRF, parseJUnit, parseProof, renderComment, renderLedgerMarkdown, OkproofPlaywrightReporter } from '../src/index.js';
import { countAssertions } from '../src/playwright.js';
import { applyVerifyFile } from '../src/verify/ledger.js';
import { runTool, tools } from '../src/mcp/tools.js';
import type { VerifyFile } from '../src/verify/types.js';

const PROOF = parseProof('## #7 Weak\n- [ ] First\n- [ ] Second\n- [ ] Third\n');

test('ledger: a passing test with zero assertions is unproven, not met', () => {
  const l = buildLedger(PROOF, [{ title: 'a [okproof:7.1]', status: 'passed', assertions: 0 }]);
  assert.equal(l.entries[0].verdict, 'unproven');
  assert.deepEqual(l.entries[0].weak, ['a [okproof:7.1]']);
  assert.equal(l.proven, false);
  const md = renderLedgerMarkdown(l);
  assert.match(md, /UNPROVEN \(no assertions\)/);
  assert.match(md, /add a real assertion: a \[okproof:7\.1\]/);
});

test('ledger: precedence is failed, then unproven, then met', () => {
  const l = buildLedger(PROOF, [
    { title: 'weak [okproof:7.1]', status: 'passed', assertions: 0 },
    { title: 'strong [okproof:7.1]', status: 'passed', assertions: 2 },
    { title: 'weak [okproof:7.2]', status: 'passed', assertions: 0 },
    { title: 'bad [okproof:7.2]', status: 'failed', assertions: 0 },
    { title: 'weak1 [okproof:7.3]', status: 'passed', assertions: 0 },
    { title: 'weak2 [okproof:7.3]', status: 'passed', assertions: 0 },
  ]);
  assert.deepEqual(l.entries.map((e) => e.verdict), ['met', 'failed', 'unproven']);
  const flaky = buildLedger(PROOF, [
    { title: 'x [okproof:7.1]', status: 'passed', assertions: 0 },
    { title: 'y [okproof:7.1]', status: 'flaky', assertions: 5 },
  ]);
  assert.equal(flaky.entries[0].verdict, 'failed');
});

test('ledger: unknown counts are not weak unless strict', () => {
  const outcomes = [{ title: 'a [okproof:7.1]', status: 'passed' }];
  assert.equal(buildLedger(PROOF, outcomes).entries[0].verdict, 'met');
  assert.equal(buildLedger(PROOF, outcomes, { strictAssertions: true }).entries[0].verdict, 'unproven');
  const known = [{ title: 'a [okproof:7.1]', status: 'passed', assertions: 1 }];
  assert.equal(buildLedger(PROOF, known, { strictAssertions: true }).entries[0].verdict, 'met');
});

test('ledger: a confirmed verifier refutation still wins as failed', () => {
  const l = buildLedger(PROOF, [{ title: 'a [okproof:7.1]', status: 'passed', assertions: 0 }]);
  const file: VerifyFile = {
    issue: '7', title: 'Weak', baseUrl: 'http://x',
    results: [{
      criterionId: '7.1', criterion: 'First', verdict: 'refuted', outcome: 'concluded',
      findings: [{ title: 'console error', severity: 5, confirmed: true } as never],
      actions: [], screenshots: [], steps: 1, usage: { input: 0, output: 0 },
    }],
  };
  const after = applyVerifyFile(l, file);
  assert.equal(after.entries[0].verdict, 'failed');
  assert.equal(after.proven, false);
});

test('finalize: strictAssertions option and env both apply; lines mention unproven', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-weak-'));
  await writeFile(join(dir, '7.md'), '## #7 Weak\n- [ ] First\n');
  const outcomes = [{ title: 'a [okproof:7.1]', status: 'passed' }];
  assert.match((await finalize(outcomes, { dir, github: false })).lines[0], /1\/1 criteria met, proven/);
  const strict = await finalize(outcomes, { dir, github: false, strictAssertions: true });
  assert.equal(strict.lines[0], 'okproof #7: 0/1 criteria met, 1 unproven (no assertions), not proven');
  process.env.OKPROOF_STRICT_ASSERTIONS = '1';
  try {
    assert.equal((await finalize(outcomes, { dir, github: false })).ledgers[0].entries[0].verdict, 'unproven');
  } finally {
    delete process.env.OKPROOF_STRICT_ASSERTIONS;
  }
  assert.match(renderComment(strict.ledgers), /Silence is not proof: #7 7\.1/);
  await rm(dir, { recursive: true, force: true });
});

// --- Playwright ---------------------------------------------------------

function pwTest(title: string) {
  return { title, id: title, titlePath: () => ['f.spec.ts', title] };
}

test('Playwright: nested expect steps are counted, including soft assertions', () => {
  const steps = [
    { category: 'hook', steps: [{ category: 'pw:api' }] },
    { category: 'test.step', steps: [{ category: 'expect' }, { category: 'test.step', steps: [{ category: 'expect' }, { category: 'expect' }] }] },
    { category: 'expect' },
  ];
  assert.equal(countAssertions(steps), 4);
  assert.equal(countAssertions([]), 0);
  assert.equal(countAssertions(undefined), undefined);
});

async function runReporter(steps: unknown, tagged = 'a [okproof:7.1]') {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-pw-'));
  await writeFile(join(dir, '7.md'), '## #7 Weak\n- [ ] First\n');
  const r = new OkproofPlaywrightReporter({ dir, github: false });
  const result: Record<string, unknown> = { status: 'passed', retry: 0, duration: 10, attachments: [] };
  if (steps !== undefined) result.steps = steps;
  r.onTestEnd(pwTest(tagged), result as never);
  const log = console.log;
  console.log = () => {};
  try {
    await r.onEnd();
  } finally {
    console.log = log;
  }
  const ledger = JSON.parse(await readFile(join(dir, 'ledger-7.json'), 'utf8'));
  await rm(dir, { recursive: true, force: true });
  return ledger.entries[0];
}

test('Playwright reporter: expect steps make a test met', async () => {
  const e = await runReporter([{ category: 'test.step', steps: [{ category: 'expect' }] }]);
  assert.equal(e.verdict, 'met');
  assert.equal(e.tests[0].assertions, 1);
});

test('Playwright reporter: zero expect steps is unproven', async () => {
  const e = await runReporter([{ category: 'pw:api' }]);
  assert.equal(e.verdict, 'unproven');
  assert.equal(e.tests[0].assertions, 0);
});

test('Playwright reporter: no steps array means unknown, still met', async () => {
  const e = await runReporter(undefined);
  assert.equal(e.verdict, 'met');
  assert.equal('assertions' in e.tests[0], false);
});

// --- JUnit / CTRF -------------------------------------------------------

test('JUnit: reads the assertions attribute when present', () => {
  const out = parseJUnit('<testcase name="a" assertions="3"/><testcase name="b" assertions="0"/><testcase name="c"/><testcase name="d" assertions="x"/>');
  assert.deepEqual(out.map((o) => o.assertions), [3, 0, undefined, undefined]);
  assert.equal('assertions' in out[2], false);
});

test('CTRF: reads extra.assertions only when it is a number', () => {
  const out = parseCTRF({
    results: { tests: [
      { name: 'a', status: 'passed', extra: { assertions: 2 } },
      { name: 'b', status: 'passed', extra: { assertions: 0 } },
      { name: 'c', status: 'passed', extra: { assertions: '4' } },
      { name: 'd', status: 'passed' },
    ] },
  });
  assert.deepEqual(out.map((o) => o.assertions), [2, 0, undefined, undefined]);
});

// --- MCP ----------------------------------------------------------------

test('okproof_status shows unproven and names the weak test', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-mcp-weak-'));
  await mkdir(join(cwd, '.okproof'));
  await writeFile(join(cwd, '.okproof', '7.md'), '## #7 Weak\n- [ ] First\n- [ ] Second\n');
  const xml = '<testcase name="first works [okproof:7.1]" assertions="0"/><testcase name="second works [okproof:7.2]" assertions="2"/>';
  await finalize(parseJUnit(xml), { dir: join(cwd, '.okproof'), github: false });
  const tool = tools.find((t) => t.name === 'okproof_status')!;
  const r = await runTool(tool, {}, { cwd });
  const text = r.content[0].text;
  assert.equal(text.split('\n')[0], 'Not done: 1 of 2 criteria proven.');
  assert.match(text, /UNPROVEN {2}7\.1/);
  assert.match(text, /- 7\.1 \(unproven\).*add a real assertion to first works \[okproof:7\.1\]/);
  assert.match(text, /MET {2}7\.2/);
  await rm(cwd, { recursive: true, force: true });
});
