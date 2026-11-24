import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, lintTests, parseJUnit, parseProof } from '../src/index.js';
import { analyzeSource } from '../src/lint.js';
import { criterionKeywords, forms, splitWords, bodyWords, missingKeywords } from '../src/relevance.js';
import { runTool, tools } from '../src/mcp/tools.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// ---------------------------------------------------------------------------
// 1. JUnit flaky variants

const wrap = (inner: string): string => `<testsuite><testcase name="t [okproof:1.1]" classname="C" time="0.5">${inner}</testcase></testsuite>`;

test('junit: Surefire flakyFailure and flakyError on a passing testcase are flaky', () => {
  const failure = '<flakyFailure message="boom" type="AssertionError"><stackTrace>at x</stackTrace></flakyFailure>';
  const error = '<flakyError message="io" type="IOException"><stackTrace>at y</stackTrace></flakyError>';
  assert.equal(parseJUnit(wrap(failure))[0]!.status, 'flaky');
  assert.equal(parseJUnit(wrap(error))[0]!.status, 'flaky');
  assert.equal(parseJUnit(wrap(`${failure}${error}<system-out>log</system-out>`))[0]!.status, 'flaky');
});

test('junit: rerunFailure and rerunError are flaky', () => {
  assert.equal(parseJUnit(wrap('<rerunFailure message="m"><stackTrace>s</stackTrace></rerunFailure>'))[0]!.status, 'flaky');
  assert.equal(parseJUnit(wrap('<rerunError message="m"/>'))[0]!.status, 'flaky');
});

test('junit: a rerun property marks a pass as flaky, a zero count does not', () => {
  assert.equal(parseJUnit(wrap('<properties><property name="rerun" value="2"/></properties>'))[0]!.status, 'flaky');
  assert.equal(parseJUnit(wrap("<properties><property name='reruns' value='1'/></properties>"))[0]!.status, 'flaky');
  assert.equal(parseJUnit(wrap('<properties><property name="rerun" value="0"/></properties>'))[0]!.status, 'passed');
  assert.equal(parseJUnit(wrap('<properties><property name="browser" value="chromium"/></properties>'))[0]!.status, 'passed');
});

test('junit: a real failure or skip still wins over a rerun marker, and a clean pass stays passed', () => {
  assert.equal(parseJUnit(wrap('<failure message="x"/><rerunFailure message="y"/>'))[0]!.status, 'failed');
  assert.equal(parseJUnit(wrap('<skipped/>'))[0]!.status, 'skipped');
  assert.equal(parseJUnit(wrap(''))[0]!.status, 'passed');
});

test('junit: a flaky testcase is never met in the ledger', () => {
  const proof = parseProof('## #1 Flaky\n- [ ] Works\n');
  const outcomes = parseJUnit(wrap('<flakyFailure message="m"/>'));
  const l = buildLedger(proof, [{ ...outcomes[0]!, assertions: 3 }]);
  assert.equal(l.entries[0]!.verdict, 'failed');
  assert.equal(l.proven, false);
});

// ---------------------------------------------------------------------------
// 2. Word helpers

test('relevance: camelCase, snake_case, kebab and acronym splitting', () => {
  assert.deepEqual(splitWords('resetPasswordEmail'), ['reset', 'password', 'email']);
  assert.deepEqual(splitWords('reset_password-email'), ['reset', 'password', 'email']);
  assert.deepEqual(splitWords('HTMLParserError'), ['html', 'parser', 'error']);
  assert.deepEqual(splitWords('user2fa Login'), ['user', 'fa', 'login']);
});

test('relevance: keywords drop stopwords, short words and duplicates', () => {
  assert.deepEqual(criterionKeywords('A user can reset the password and the password is saved'), ['reset', 'password', 'saved']);
  assert.deepEqual(criterionKeywords('It is OK to do so'), []);
});

test('relevance: stemming strips s, es, ed and ing on both sides', () => {
  const body = bodyWords('', ['resetting passwords']);
  assert.deepEqual(missingKeywords(['reset', 'password'], body), []);
  assert.ok(forms('saving').includes('save'));
  assert.ok(forms('saved').includes('save'));
  assert.ok(forms('boxes').includes('box'));
  assert.deepEqual(missingKeywords(['invoice'], body), ['invoice']);
});

// ---------------------------------------------------------------------------
// 2b. Relevance through the analyzer

const PROOF = '## #5 Lint\n- [ ] A user can reset their password by email\n- [ ] The cart shows the total price\n- [ ] Done\n';

async function project(files: Record<string, string>, proof = PROOF) {
  const root = await mkdtemp(join(tmpdir(), 'okproof-sig-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '5.md'), proof);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

test('relevance: TS test that never mentions its criterion is reported, with the unmatched words', async () => {
  const root = await project({
    'a.test.ts': "test('login works [okproof:5.1]', async ({ page }) => {\n  await page.goto('/home');\n  expect(await page.title()).toBe('Welcome');\n});\n",
  });
  const r = await lintTests({ dir: root });
  assert.equal(r.unrelated.length, 1);
  const u = r.unrelated[0]!;
  assert.equal(u.id, '5.1');
  assert.equal(u.test, 'login works');
  assert.ok(u.missing.includes('password') && u.missing.includes('reset'));
  assert.match(r.lines.join('\n'), /possibly unrelated: test 'login works' claims 5\.1 \('A user can reset their password by email'\) but never mentions /);
  assert.equal(r.ok, true, 'advisory by default');
  assert.equal((await lintTests({ dir: root, strictRelevance: true })).ok, false);
  await rm(root, { recursive: true, force: true });
});

test('relevance: a title that copies the criterion does not count, the body must mention it', () => {
  const src = "test('user can reset password by email [okproof:5.1]', async ({ page }) => {\n  await page.goto('/x');\n  expect(page.url()).toContain('/x');\n});\n";
  const t = analyzeSource(src, false).tests[0]!;
  assert.equal(t.words.has('reset'), false);
  assert.equal(t.words.has('password'), false);
});

test('relevance: identifiers (camelCase), string literals and stems all count as mentions', () => {
  const ident = analyzeSource("test('t [okproof:5.1]', async () => {\n  const mail = await resetPasswordEmail();\n  expect(mail).toBeDefined();\n});\n", false).tests[0]!;
  assert.deepEqual(missingKeywords(criterionKeywords('A user can reset their password by email'), ident.words), []);
  const lit = analyzeSource("test('t [okproof:5.2]', async ({ page }) => {\n  await expect(page.getByText('Total price: $5')).toBeVisible();\n});\n", false).tests[0]!;
  assert.ok(lit.words.has('total') && lit.words.has('price'));
  const stem = analyzeSource("test('t [okproof:5.1]', async () => {\n  expect(await resettingPasswords()).toBe(true);\n});\n", false).tests[0]!;
  assert.ok(missingKeywords(criterionKeywords('A user can reset their password by email'), stem.words).length < 4);
});

test('relevance: one shared keyword is enough to stay quiet; related tests are not reported', async () => {
  const root = await project({
    'a.test.ts': "test('cart [okproof:5.2]', async () => {\n  expect(cartTotal([1, 2])).toBe(3);\n});\n",
    'b.test.ts': "test('mail [okproof:5.1]', async () => {\n  expect(await sendResetEmail()).toBe('sent');\n});\n",
  });
  const r = await lintTests({ dir: root });
  assert.deepEqual(r.unrelated, []);
  await rm(root, { recursive: true, force: true });
});

test('relevance: Python test, unrelated and related', async () => {
  const root = await project({
    'test_a.py': "def test_x():  # [okproof:5.1]\n    response = client.get('/health')\n    assert response.status_code == 200\n\ndef test_y():  # [okproof:5.2]\n    total = cart.total_price()\n    assert total == 5\n",
  });
  const r = await lintTests({ dir: root });
  assert.deepEqual(r.unrelated.map((u) => [u.id, u.test]), [['5.1', 'test_x']]);
  await rm(root, { recursive: true, force: true });
});

test('relevance: a criterion made only of stopwords, and a test with no assertions, are not reported as unrelated', async () => {
  const root = await project({
    'a.test.ts': "test('x [okproof:5.3]', () => { expect(zzz()).toBe(1); });\ntest('y [okproof:5.1]', () => { go(); });\n",
  });
  const r = await lintTests({ dir: root });
  assert.deepEqual(r.unrelated, []);
  assert.equal(r.weak.length, 1);
  await rm(root, { recursive: true, force: true });
});

test('relevance: documented false positive, a synonym is reported (advisory)', () => {
  const src = "test('t [okproof:5.1]', async () => {\n  expect(await changePass()).toBe(true);\n});\n";
  const t = analyzeSource(src, false).tests[0]!;
  assert.equal(missingKeywords(criterionKeywords('A user can reset their password by email'), t.words).length, 3);
});

// ---------------------------------------------------------------------------
// 3. Trivial assertions

const weakOf = (src: string, py = false) => analyzeSource(src, py).tests.map((t) => [t.weak, t.trivial]);

test('lint: tests whose only assertions are trivial are weak', () => {
  const ts = (body: string) => `test('t [okproof:5.1]', async () => {\n  ${body}\n});\n`;
  for (const body of [
    'expect(true).toBe(true);',
    'expect(1).toBe(1);',
    'expect(1).toEqual(1);',
    'expect(true).toBeTruthy();',
    'assert.ok(true);',
    'assert(true);',
    'assert.equal(1, 1);',
    'assert.strictEqual(true, true);',
    "expect('a').toBe('a');",
    'expect(true).toBe(true); expect(2).toBe(2);',
  ]) {
    assert.deepEqual(weakOf(ts(body)), [[true, true]], body);
  }
  for (const body of ['assert True', 'assert 1', 'assert True, "always"', 'assert 1 == 1', 'self.assertTrue(True)', 'self.assertEqual(1, 1)']) {
    assert.deepEqual(weakOf(`def test_t():  # [okproof:5.1]\n    ${body}\n`, true), [[true, true]], body);
  }
});

test('lint: one real assertion next to a trivial one is not weak; no assertion is weak but not trivial', () => {
  assert.deepEqual(weakOf("test('t [okproof:5.1]', () => {\n  expect(true).toBe(true);\n  expect(add(1, 2)).toBe(3);\n});\n"), [[false, false]]);
  assert.deepEqual(weakOf("test('t [okproof:5.1]', () => {\n  expect(true).toBe(true);\n  expect(flag).toBe(true);\n});\n"), [[false, false]]);
  assert.deepEqual(weakOf("test('t [okproof:5.1]', () => { go(); });\n"), [[true, false]]);
  assert.deepEqual(weakOf('def test_t():  # [okproof:5.1]\n    assert x == 1\n', true), [[false, false]]);
  assert.deepEqual(weakOf('def test_t():  # [okproof:5.1]\n    assert True\n    assert result.ok\n', true), [[false, false]]);
});

test('lint: trivial weak tests are reported with their own message', async () => {
  const root = await project({ 'a.test.ts': "test('t [okproof:5.1]', () => { expect(true).toBe(true); });\n" });
  const r = await lintTests({ dir: root });
  assert.equal(r.weak.length, 1);
  assert.equal(r.weak[0]!.reason, 'trivial');
  assert.match(r.lines.join('\n'), /WEAK .*only trivial assertions/);
  assert.equal(r.ok, false);
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Exit codes and MCP

test('lint CLI: --strict-relevance turns unrelated tests into exit 1; default is exit 0', async () => {
  const root = await project({ 'a.test.ts': "test('t [okproof:5.1]', () => { expect(health()).toBe('up'); });\n" });
  const plain = spawnSync(process.execPath, [cli, 'lint', root], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /possibly unrelated/);
  const strict = spawnSync(process.execPath, [cli, 'lint', '--strict-relevance', root], { encoding: 'utf8' });
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  const after = spawnSync(process.execPath, [cli, 'lint', root, '--strict-relevance'], { encoding: 'utf8' });
  assert.equal(after.status, 1);
  await rm(root, { recursive: true, force: true });
});

test('lint CLI: a trivial-assertion test exits 1 without any flag', async () => {
  const root = await project({ 'a.test.ts': "test('reset password by email [okproof:5.1]', () => { expect(true).toBe(true); });\n" });
  const r = spawnSync(process.execPath, [cli, 'lint', root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  await rm(root, { recursive: true, force: true });
});

test('MCP okproof_lint reports possibly-unrelated warnings, strictRelevance, and trivial weak tests', async () => {
  const tool = tools.find((t) => t.name === 'okproof_lint')!;
  const text = (r: { content: { text: string }[] }): string => r.content[0]!.text;
  const root = await project({ 'a.test.ts': "test('t [okproof:5.1]', () => { expect(health()).toBe('up'); });" });
  const warn = await runTool(tool, {}, { cwd: root });
  assert.match(text(warn), /Lint passed with 1 possibly-unrelated warning/);
  assert.match(text(warn), /possibly unrelated: test 't'/);
  const strict = await runTool(tool, { strictRelevance: true }, { cwd: root });
  assert.match(text(strict), /Lint failed/);
  const root2 = await project({ 'b.test.ts': "test('u [okproof:5.2]', () => { expect(true).toBe(true); });" });
  const trivial = await runTool(tool, {}, { cwd: root2 });
  assert.match(text(trivial), /Lint failed/);
  assert.match(text(trivial), /only trivial assertions/);
  await rm(root, { recursive: true, force: true });
  await rm(root2, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Performance

test('lint and junit stay fast on 200 KB of pathological input', async () => {
  const big = 200_000;
  const inputs = [
    `test('t [okproof:5.1]', () => {\n${'expect('.repeat(big / 7)}\n});\n`,
    `test('t [okproof:5.1]', () => {\n${'aB'.repeat(big / 2)} expect(1).toBe(2);\n});\n`,
    `test('t [okproof:5.1]', () => {\n${' '.repeat(big)}expect(true).toBe(true);\n});\n`,
    `test('t [okproof:5.1]', () => {\n${'expect(true)'.repeat(big / 12)}\n});\n`,
    `test('t [okproof:5.1]', () => {\n${"'a b c ".repeat(big / 7)}\n});\n`,
    `test('t [okproof:5.1]', () => {\n${'assert.equal('.repeat(big / 13)}\n});\n`,
    `def test_t():  # [okproof:5.1]\n    ${'assert '.repeat(big / 7)}\n`,
    `def test_t():  # [okproof:5.1]\n${'    assert True,' + ' '.repeat(100) + '\n'}${' '.repeat(big)}\n`,
  ];
  for (const [i, src] of inputs.entries()) {
    const start = Date.now();
    analyzeSource(src, src.startsWith('def '));
    assert.ok(Date.now() - start < 500, `input ${i} took ${Date.now() - start} ms`);
  }
  const crit = Date.now();
  criterionKeywords('word '.repeat(big / 5));
  splitWords('aB_c-D'.repeat(big / 6));
  assert.ok(Date.now() - crit < 500);
  const xml = Date.now();
  parseJUnit(`<testcase name="x">${'<property name="rerun" value="0"/>'.repeat(big / 34)}${'<flaky'.repeat(big / 6)}</testcase>`);
  parseJUnit(`<testcase name="x"><property ${'name '.repeat(big / 5)}</testcase>`);
  assert.ok(Date.now() - xml < 500, `junit took ${Date.now() - xml} ms`);
});
