// Independent review, round 2: stronger weak-assertion detection, overclaiming tests,
// and lint upgrading an unknown assertion count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSource, applyLintToOutcomes, lintOutcomes, lintTests } from '../src/lint.js';
import { judge } from '../src/weak-signals.js';

const one = (body: string, python = false) => {
  const src = python
    ? `def test_x():  # [okproof:1.1]\n${body.split('\n').map((l) => `    ${l}`).join('\n')}\n`
    : `test('x [okproof:1.1]', async ({ page }) => {\n${body}\n});\n`;
  const found = analyzeSource(src, python).tests;
  assert.equal(found.length, 1, src);
  return found[0]!;
};
const weak = (body: string, python = false) => assert.equal(one(body, python).weak, true, body);
const strong = (body: string, python = false) => assert.equal(one(body, python).weak, false, body);

test('constant-only comparisons are trivial', () => {
  weak('expect(2+2).toBe(4);');
  weak('expect(2 * 3).toEqual(6); expect(true).toBe(true);');
  weak('expect(10).toBeGreaterThan(1);');
  weak('expect(1).toBeTruthy();');
  weak("expect('a' + 'b').toBe('ab');");
  strong('expect(await page.title()).toBe("Home");');
  strong('expect(count).toBe(4);');
  strong('expect(2).toBe(count);');
});

test('asserting a fixture is defined proves nothing about the app', () => {
  weak('expect(page).toBeDefined();');
  weak('expect(browser).toBeTruthy();');
  weak('expect(context).not.toBeNull();');
  weak('expect(driver).not.toBeUndefined();');
  weak('expect(!!page).toBe(true);');
  weak('expect(!!app).toBeTruthy();');
  strong('expect(page).toHaveURL(/home/);');
  strong('expect(user).toBeDefined();');
  strong('expect(page).toBeDefined(); expect(await page.title()).toBe("x");');
});

test('expect.assertions(0) is weak, expect.assertions(n) and hasAssertions are not assertions', () => {
  weak('expect.assertions(0);');
  weak('expect.assertions(0); await page.goto("/");');
  weak('expect.assertions(1);');
  weak('expect.hasAssertions();');
  strong('expect.assertions(1); expect(total).toBe(3);');
});

test('assertions in dead code do not count', () => {
  const t = one('if (false) { expect(total).toBe(3); }');
  assert.equal(t.weak, true);
  assert.equal(t.detail, 'only in dead code');
  weak('if (0) { expect(total).toBe(3); }');
  weak('if (0) expect(total).toBe(3);');
  weak('await page.goto("/");\nreturn;\nexpect(total).toBe(3);');
  weak('throw new Error("skip");\nexpect(total).toBe(3);');
  strong('if (!ready) return;\nexpect(total).toBe(3);');
  strong('if (x) { return; }\nexpect(total).toBe(3);');
  strong('if (false) { expect(a).toBe(1); }\nexpect(total).toBe(3);');
  strong('if (ok) { expect(total).toBe(3); }');
  strong('const f = () => { return 1; };\nexpect(f()).toBe(1);');
});

test('assertions only in a function the test never calls do not count', () => {
  const t = one('function check() { expect(total).toBe(3); }');
  assert.equal(t.weak, true);
  assert.equal(t.detail, 'only in a function the test never calls');
  weak('const check = async () => { expect(total).toBe(3); };');
  weak('const check = function () { expect(total).toBe(3); };');
  weak('async function check(): Promise<void> { expect(total).toBe(3); }');
  strong('function check() { expect(total).toBe(3); }\ncheck();');
  strong('const check = async () => { expect(total).toBe(3); };\nawait check();');
  strong('const check = () => { expect(total).toBe(3); };\nawait page.waitForFunction(check);');
  strong('const total = (await foo(() => 1));\nexpect(total).toBe(3);');
});

test('assertions only inside a try/catch that swallows the failure do not count', () => {
  const t = one('try { expect(total).toBe(3); } catch (e) {}');
  assert.equal(t.weak, true);
  assert.equal(t.detail, 'only inside try/catch that swallows the failure');
  weak('try { expect(total).toBe(3); } catch { console.log("meh"); }');
  strong('try { expect(total).toBe(3); } catch (e) { throw e; }');
  strong('try { expect(total).toBe(3); } catch (e) { expect(e).toBeNull(); }');
  strong('try { await page.click("a"); } catch {}\nexpect(total).toBe(3);');
  strong('try { expect(total).toBe(3); } finally { await page.close(); }');
});

test('python: constant and fixture asserts are trivial', () => {
  weak('assert 2 + 2 == 4', true);
  weak('assert driver is not None', true);
  weak('assert page', true);
  weak('assert True', true);
  strong('assert total == 4', true);
  strong('assert driver.title == "Home"', true);
});

test('judge() reports no detail for the classic trivial patterns', () => {
  const j = judge('expect(true).toBe(true);');
  assert.equal(j.weak, true);
  assert.equal(j.detail, undefined);
});

test('lint overrides a runner assertion count for every new weak reason', () => {
  const src = `test('x [okproof:1.1]', async () => { if (false) { expect(a).toBe(1); } });\n`;
  const f = analyzeSource(src, false);
  assert.equal(f.tests[0]!.weak, true);
  const weakFinding = { file: 'a.spec.ts', line: 1, ids: ['1.1'], title: '', reason: 'trivial' as const, name: 'x', detail: f.tests[0]!.detail };
  const r = applyLintToOutcomes([{ title: 'x [okproof:1.1]', status: 'passed', assertions: 5 }], [weakFinding]);
  assert.equal(r.outcomes[0]!.assertions, 0);
});

test('lint upgrades an unknown count when it finds a real assertion, never a known one', () => {
  const asserting = { file: 'a.spec.ts', line: 1, ids: ['1.1'], title: '', name: 'does it' };
  const r = applyLintToOutcomes(
    [
      { title: 'does it [okproof:1.1]', status: 'passed' },
      { title: 'does it [okproof:1.1]', status: 'passed', assertions: 0 },
      { title: 'other [okproof:1.2]', status: 'passed' },
    ],
    [],
    [asserting],
  );
  assert.deepEqual(r.outcomes.map((o) => o.assertions), [1, 0, undefined]);
  assert.deepEqual(r.upgraded, ['does it [okproof:1.1]']);
});

async function project(spec: string, proof = '## #1 Demo\n- [ ] The user can sign in with a password\n- [ ] The user can sign out\n- [ ] A cart total shows tax\n- [ ] Orders can be cancelled\n'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okp-lint2-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '1.md'), proof);
  await writeFile(join(root, 'a.spec.ts'), spec);
  return root;
}

test('lintOutcomes: a node:test style run with no counts gets a real assertion from lint', async () => {
  const root = await project(`test('user can sign in with a password [okproof:1.1]', () => { expect(session.user).toBe('ann'); });\n`);
  try {
    const r = await lintOutcomes([{ title: 'user can sign in with a password [okproof:1.1]', status: 'passed' }], { dir: root, proofDir: join(root, '.okproof') });
    assert.equal(r.outcomes[0]!.assertions, 1);
    assert.match(r.lines.join('\n'), /real assertion found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const MANY = `test('sign in sign out tax cancelled password [okproof:1.1] [okproof:1.2] [okproof:1.3] [okproof:1.4]', () => { expect(passwordSignOutTaxCancelled).toBe(1); });\n`;

test('a test claiming more than 3 criteria is flagged; advisory unless --strict-relevance', async () => {
  const root = await project(MANY);
  try {
    const r = await lintTests({ dir: root });
    assert.equal(r.overclaims.length, 1);
    assert.deepEqual(r.overclaims[0]!.ids, ['1.1', '1.2', '1.3', '1.4']);
    assert.equal(r.ok, true);
    assert.match(r.lines.join('\n'), /OVERCLAIM/);
    const strict = await lintTests({ dir: root, strictRelevance: true });
    assert.equal(strict.ok, false);
    const raised = await lintTests({ dir: root, strictRelevance: true, maxClaims: 4 });
    assert.equal(raised.overclaims.length, 0);
    assert.equal(raised.ok, true);
    const out = await lintOutcomes([], { dir: root, proofDir: join(root, '.okproof'), strictRelevance: true });
    assert.equal(out.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('performance: nested dead-code constructs stay linear', () => {
  const body = 'if (false) { '.repeat(3000) + 'expect(a).toBe(1);' + ' }'.repeat(3000);
  const t0 = Date.now();
  judge(body);
  judge('function f() { '.repeat(2000) + 'expect(a).toBe(1);' + ' }'.repeat(2000));
  judge('try { '.repeat(2000) + 'expect(a).toBe(1);' + ' } catch (e) {}'.repeat(2000));
  judge('return;\n'.repeat(5000) + 'expect(a).toBe(1);');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
