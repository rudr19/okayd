import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTests } from '../src/index.js';
import { analyzeSource } from '../src/lint.js';
import { runTool, tools } from '../src/mcp/tools.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(files: Record<string, string>, proof = '## #5 Lint\n- [ ] One\n- [ ] Two\n- [ ] Three\n') {
  const root = await mkdtemp(join(tmpdir(), 'okproof-lint-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '5.md'), proof);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

const weakOf = (src: string, py = false) => analyzeSource(src, py).tests.map((t) => t.weak);

test('lint: TS test with expect is fine; empty and console.log-only are weak', () => {
  assert.deepEqual(weakOf("test('a [okproof:5.1]', async () => {\n  expect(add(1)).toBe(2);\n});\n"), [false]);
  assert.deepEqual(weakOf("test('a [okproof:5.1]', async () => {\n});\n"), [true]);
  assert.deepEqual(weakOf("test('a [okproof:5.1]', async ({ page }) => {\n  await page.goto('/');\n  console.log('expect(x)');\n});\n"), [true]);
  assert.deepEqual(weakOf("test('a [okproof:5.1]', async () => { await x(); });\ntest('b [okproof:5.2]', () => { assert.equal(add(1), 2); });"), [true, false]);
  assert.deepEqual(weakOf("it(\n  'multi [okproof:5.1]',\n  async () => {\n    cy.get('a').should('exist');\n  },\n);\n"), [false]);
});

test('lint: braces, brackets and quotes in strings, comments and regexes do not confuse the scanner', () => {
  const src = [
    "test('a [okproof:5.1]', async () => {",
    "  const s = '}})]]';",
    '  const t = `}} ${ \'{\' }`;',
    '  // } ) ] closing everything',
    '  /* }}} */',
    '  const r = /[})]/;',
    '  expect(s).toBe(t);',
    '});',
    "test('b [okproof:5.2]', () => {",
    "  const s = '})';",
    '});',
  ].join('\n');
  assert.deepEqual(weakOf(src), [false, true]);
  // An assertion word that appears only in a string or comment does not count.
  assert.deepEqual(weakOf("test('a [okproof:5.1]', () => {\n  // expect(1)\n  const s = 'assert(x)';\n});"), [true]);
});

test('lint: two tags in one title are one test; later tests are not swallowed', () => {
  const found = analyzeSource("test('a [okproof:5.1] [okproof:5.2]', () => {});\ntest('b [okproof:5.3]', () => { expect(add(1)).toBe(2); });", false);
  assert.deepEqual(found.tests.map((t) => t.ids), [['5.1', '5.2'], ['5.3']]);
  assert.deepEqual(found.tests.map((t) => t.weak), [true, false]);
});

test('lint: Python assert is fine, no assert is weak, decorators and docstring tags work', () => {
  const py = [
    'def test_ok():  # [okproof:5.1]',
    '    x = 1',
    '    assert x == 1',
    '',
    'def test_weak():  # [okproof:5.2]',
    '    x = "assert"  # assert',
    '    print(x)',
    '',
    '# [okproof:5.3]',
    'def test_after_comment():',
    '    assert ok',
    '',
    'def test_doc():',
    '    """[okproof:5.4] docs"""',
    '    return 1',
  ].join('\n');
  const t = analyzeSource(py, true).tests;
  assert.deepEqual(t.map((x) => [x.ids[0], x.weak]), [['5.1', false], ['5.2', true], ['5.3', false], ['5.4', true]]);
});

test('lint: Go t.Run bodies', () => {
  const go = 'func TestX(t *testing.T) {\n\tt.Run("a [okproof:5.1]", func(t *testing.T) {\n\t\tif got != want { t.Errorf("x") }\n\t})\n\tt.Run("b [okproof:5.2]", func(t *testing.T) {\n\t\t_ = 1\n\t})\n}\n';
  assert.deepEqual(analyzeSource(go, false).tests.map((x) => x.weak), [false, true]);
});

test('lintTests: reports weak, dangling and untested; ok is false only for weak or dangling', async () => {
  const root = await project({
    'src/a.test.ts': "test('one [okproof:5.1]', () => { expect(add(1)).toBe(2); });\ntest('two [okproof:5.2]', () => {});\ntest('ghost [okproof:9.9]', () => { expect(add(1)).toBe(2); });\n",
    'py/test_b.py': 'def test_three():  # [okproof:5.3]\n    assert ok\n',
    'node_modules/x/c.test.ts': "test('skipped [okproof:5.1]', () => {});",
    'dist/d.test.js': "test('skipped [okproof:5.1]', () => {});",
  });
  const r = await lintTests({ dir: root });
  assert.equal(r.filesScanned, 2);
  assert.deepEqual(r.weak.map((w) => [w.file, w.ids]), [['src/a.test.ts', ['5.2']]]);
  assert.deepEqual(r.dangling.map((d) => d.ids), [['9.9']]);
  assert.deepEqual(r.untested, []);
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /WEAK +src\/a\.test\.ts:2 /);
  assert.match(r.lines.join('\n'), /DANGLING +src\/a\.test\.ts:3 /);

  const narrow = await lintTests({ dir: root, tests: 'py' });
  assert.equal(narrow.filesScanned, 1);
  assert.equal(narrow.ok, true);
  assert.deepEqual(narrow.untested.map((u) => u.id), ['5.1', '5.2']);
  const glob = await lintTests({ dir: root, tests: 'src/**/*.test.ts' });
  assert.equal(glob.filesScanned, 1);
  await rm(root, { recursive: true, force: true });
});

test('lintTests: missing proof folder skips cross-checks; unknown tests path throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-lint-'));
  await writeFile(join(root, 'a.spec.ts'), "test('x [okproof:1.1]', () => { expect(add(1)).toBe(2); });");
  const r = await lintTests({ dir: root });
  assert.equal(r.ok, true);
  assert.match(r.lines.join('\n'), /no proof files found/);
  await assert.rejects(lintTests({ dir: root, tests: 'nope' }), /No such test path/);
  await rm(root, { recursive: true, force: true });
});

test('lint CLI: exit 1 for a weak test, 0 when clean', async () => {
  const bad = await project({ 'a.test.ts': "test('x [okproof:5.1]', () => {});" });
  const r1 = spawnSync(process.execPath, [cli, 'lint', bad], { encoding: 'utf8' });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /WEAK/);
  const good = await project({ 'a.test.ts': "test('x [okproof:5.1]', () => { expect(add(1)).toBe(2); });" });
  const r2 = spawnSync(process.execPath, [cli, 'lint', '--tests', 'a.test.ts', good], { encoding: 'utf8' });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /0 weak/);
  await rm(bad, { recursive: true, force: true });
  await rm(good, { recursive: true, force: true });
});

test('ingest --strict-assertions makes unknown counts unproven', async () => {
  const root = await project({}, '## #1 Demo\n- [ ] Does it\n');
  await writeFile(join(root, '.okproof', '1.md'), '## #1 Demo\n- [ ] Does it\n');
  await writeFile(join(root, 'j.xml'), '<testcase name="a [okproof:1.1]"/>');
  const env = { ...process.env, GITHUB_ACTIONS: '' };
  const off = spawnSync(process.execPath, [cli, 'ingest', join(root, 'j.xml'), join(root, '.okproof')], { encoding: 'utf8', env });
  assert.match(off.stdout, /1\/1 criteria met, proven/);
  const on = spawnSync(process.execPath, [cli, 'ingest', join(root, 'j.xml'), join(root, '.okproof'), '--strict-assertions'], { encoding: 'utf8', env });
  assert.match(on.stdout, /1 unproven \(no assertions\), not proven/);
  const gate = spawnSync(process.execPath, [cli, 'gate', join(root, '.okproof')], { encoding: 'utf8' });
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /UNPROVEN \(no assertions\)/);
  await rm(root, { recursive: true, force: true });
});

test('lint performance: a 200 KB pathological line finishes quickly', () => {
  const cases = [
    "test('x [okproof:5.1]', () => {" + '('.repeat(200_000),
    "test('x [okproof:5.1]', () => {" + "'".repeat(200_000),
    '[okproof:5.1]'.repeat(18_000),
    "test('[okproof:5.1]' " + '[okproof:'.repeat(28_000),
    '/'.repeat(100_000) + "test('x [okproof:5.1]', () => {})" + '`'.repeat(100_000),
  ];
  for (const src of cases) {
    const start = Date.now();
    analyzeSource(src, false);
    analyzeSource(src, true);
    assert.ok(Date.now() - start < 500, `slow on a ${src.length} char line`);
  }
});

test('okproof_lint MCP tool reports weak tests and refuses paths outside the working directory', async () => {
  const root = await project({ 'a.test.ts': "test('x [okproof:5.1]', () => {});" });
  const tool = tools.find((t) => t.name === 'okproof_lint')!;
  const ok = await runTool(tool, {}, { cwd: root });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /Lint failed/);
  assert.match(ok.content[0].text, /WEAK/);
  const out = await runTool(tool, { dir: '..' }, { cwd: root });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /outside the working directory/);
  const out2 = await runTool(tool, { tests: '../../**/*.ts' }, { cwd: root });
  assert.equal(out2.isError, true);
  await rm(root, { recursive: true, force: true });
});
