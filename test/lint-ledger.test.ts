import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSource, applyLintToOutcomes, globMatch, lintTests, scanBraces } from '../src/lint.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(strongBody = 'assert.equal(1 + 1, 2);') {
  const root = await mkdtemp(join(tmpdir(), 'okproof-lint-ledger-'));
  await mkdir(join(root, '.okproof'));
  await mkdir(join(root, 'ui'));
  await writeFile(join(root, '.okproof', '1.md'), '## #1 Demo\n- [ ] Upload a file\n- [ ] Download a file\n');
  await writeFile(
    join(root, 'ui', 'a.test.ts'),
    `test('upload a file [okproof:1.1]', async () => {\n  await upload();\n});\ntest('download a file [okproof:1.2]', async () => {\n  ${strongBody}\n  // download a file\n});\n`,
  );
  // node's JUnit has no assertion counts
  await writeFile(
    join(root, 'junit.xml'),
    '<testsuite><testcase name="upload a file [okproof:1.1]"/><testcase name="download a file [okproof:1.2]"/></testsuite>',
  );
  return root;
}

const run = (root: string, argv: string[]) =>
  spawnSync(process.execPath, [cli, ...argv], { cwd: root, encoding: 'utf8', env: { ...process.env, OKPROOF_NO_COMMENT: '1', GITHUB_ACTIONS: '' } });

test('ingest without --lint trusts the runner: a no-assertion test is met', async () => {
  const root = await project();
  assert.equal(run(root, ['ingest', 'junit.xml']).status, 0);
  const l = JSON.parse(await readFile(join(root, '.okproof', 'ledger-1.json'), 'utf8'));
  assert.equal(l.entries[0].verdict, 'met');
});

test('ingest --lint marks the no-assertion test weak: criterion unproven', async () => {
  const root = await project();
  const r = run(root, ['ingest', 'junit.xml', '--lint']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /marked weak/);
  const l = JSON.parse(await readFile(join(root, '.okproof', 'ledger-1.json'), 'utf8'));
  assert.equal(l.entries[0].verdict, 'unproven');
  assert.deepEqual(l.entries[0].weak, ['upload a file [okproof:1.1]']);
  assert.equal(l.entries[1].verdict, 'met');
  assert.equal(l.proven, false);
});

test('ingest --lint <path> limits the scan; a path with no matching test leaves the verdict alone', async () => {
  const root = await project();
  await mkdir(join(root, 'other'));
  assert.equal(run(root, ['ingest', 'junit.xml', '--lint', 'other']).status, 0);
  const l = JSON.parse(await readFile(join(root, '.okproof', 'ledger-1.json'), 'utf8'));
  assert.equal(l.entries[0].verdict, 'met');
  const r = run(root, ['ingest', 'junit.xml', '--lint=ui/**/*.test.ts']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(await readFile(join(root, '.okproof', 'ledger-1.json'), 'utf8')).entries[0].verdict, 'unproven');
});

test('gate --results --lint fails on the weak test; without --lint it passes', async () => {
  const root = await project();
  assert.equal(run(root, ['gate', '--results', 'junit.xml']).status, 0);
  const r = run(root, ['gate', '--results', 'junit.xml', '--lint']);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /unproven|no assertions|weak/i);
});

test('gate --lint without --results is a usage error', async () => {
  const root = await project();
  assert.equal(run(root, ['gate', '--lint']).status, 2);
});

test('relevance stays advisory with --lint; --strict-relevance makes ingest fail', async () => {
  const root = await project('assert.equal(compute(), 42);');
  const r = run(root, ['ingest', 'junit.xml', '--lint']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /possibly unrelated/);
  const s = run(root, ['ingest', 'junit.xml', '--lint', '--strict-relevance']);
  assert.equal(s.status, 1);
});

test('a runner assertion count stands, except for trivial assertions', () => {
  const weak = [
    { file: 'a', line: 1, ids: ['1.1'], title: '', name: 'upload', reason: 'none' as const },
    { file: 'a', line: 5, ids: ['1.2'], title: '', name: 'download', reason: 'trivial' as const },
  ];
  const out = applyLintToOutcomes(
    [
      { title: 'upload [okproof:1.1]', status: 'passed', assertions: 3 },
      { title: 'download [okproof:1.2]', status: 'passed', assertions: 1 },
      { title: 'upload [okproof:1.2]', status: 'passed' },
    ],
    weak,
  );
  assert.deepEqual(out.outcomes.map((o) => o.assertions), [3, 0, undefined]);
  assert.deepEqual(out.marked, ['download [okproof:1.2]']);
});

test('relevance: regex and template literals count as text', async () => {
  const src = [
    "test('page shows the heading [okproof:1.1]', () => {",
    '  assert.match(text, /- heading "Rudra" \\[level=1\\]/);',
    '});',
  ].join('\n');
  const found = analyzeSource(src, false).tests[0]!;
  assert.ok(found.words.has('heading'));
  assert.ok(found.words.has('rudra'));
  const tpl = analyzeSource("test('x [okproof:1.1]', () => { assert.ok(s.includes(`shows the heading`)); });", false).tests[0]!;
  assert.ok(tpl.words.has('heading'));
  const root = await mkdtemp(join(tmpdir(), 'okproof-rel-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '1.md'), '## #1 P\n- [ ] The page has a heading\n');
  await writeFile(join(root, 'a.test.ts'), src);
  const r = await lintTests({ dir: root });
  assert.deepEqual(r.unrelated, []);
});

test('scanner: regex after return, "(" , line start; division stays division', () => {
  const lits = (s: string) => scanBraces(s, 0, 0).lits;
  assert.deepEqual(lits('return /abc "q"/.test(x)'), ['abc "q"']);
  assert.deepEqual(lits('x = f(/a(b/g)'), ['a(b']);
  assert.deepEqual(lits('a\n/lineStart/.test(b)'), ['lineStart']);
  assert.deepEqual(lits('x = a / b / c'), []);
  assert.deepEqual(lits('x = (a) / 2 + y / 3'), []);
  assert.deepEqual(lits('x = [1] / 2, y = "s"'), ['s']);
});

test('scanner stays linear on a line of unclosed regex starts', () => {
  const src = '(/['.repeat(200_000);
  const t0 = Date.now();
  scanBraces(src, 0, 0);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('globMatch: *, **, ? and literals', () => {
  assert.ok(globMatch('ui/**/*.spec.ts', 'ui/a.spec.ts'));
  assert.ok(globMatch('ui/**/*.spec.ts', 'ui/x/y/a.spec.ts'));
  assert.ok(!globMatch('ui/*.spec.ts', 'ui/x/a.spec.ts'));
  assert.ok(globMatch('**/a.test.ts', 'a.test.ts'));
  assert.ok(globMatch('src/**', 'src/a/b'));
  assert.ok(globMatch('t?st.js', 'test.js'));
  assert.ok(!globMatch('t?st.js', 'tst.js'));
  assert.ok(globMatch('a.b+c(d).ts', 'a.b+c(d).ts'));
  assert.ok(!globMatch('a.ts', 'axts'));
  assert.ok(globMatch('*', 'anything'));
  assert.ok(!globMatch('*', 'a/b'));
});

test('globMatch: pathological patterns are fast and long patterns are refused', () => {
  const t0 = Date.now();
  assert.equal(globMatch('*a*a*a*a*a*a*b', 'a'.repeat(10_000)), false);
  assert.equal(globMatch('**/**/**/**/**/x', 'a/'.repeat(2000) + 'y'), false);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.throws(() => globMatch('a'.repeat(513), 'a'), /512/);
});

test('action.yml has a lint input (auto by default, off disables) that reaches ingest and gate through env', async () => {
  const yml = await readFile(fileURLToPath(new URL('../../action.yml', import.meta.url)), 'utf8');
  assert.match(yml, /\n {2}lint:\n[\s\S]*?default: auto/);
  assert.equal((yml.match(/LINT: \$\{\{ inputs\.lint \}\}/g) ?? []).length, 2);
  assert.match(yml, /ingest "\$RESULTS" "\$DIR" "\$\{lint\[@\]\}"/);
  assert.match(yml, /gate --results "\$RESULTS" .*"\$\{lint\[@\]\}"/);
  assert.doesNotMatch(yml, /--lint "\$LINT"/);
});

test('--lint= (empty) is a bare --lint, so a proof folder can follow it', async () => {
  const root = await project();
  const r = run(root, ['gate', '--results', 'junit.xml', '--lint=', '.okproof']);
  assert.equal(r.status, 1);
});
