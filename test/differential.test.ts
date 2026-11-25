// Differential proof and revert check, end to end, in tiny throwaway git repos.
// The "test runner" is a small node script: each case in test/cases.json names
// a file and the text it must contain, and the script writes JUnit XML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../src/differential.js';
import { groupFiles } from '../src/revert.js';
import { isSourceFile, isTestFile, gitAvailable } from '../src/worktree.js';
import { parseProof } from '../src/proof.js';
import type { TestOutcome } from '../src/ledger.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const haveGit = gitAvailable();
const skip = haveGit ? false : 'git is not installed';

const RUNNER = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const cases = JSON.parse(readFileSync('test/cases.json', 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const rows = cases.map((c) => {
  let ok = false;
  if (c.any) ok = c.any.some((a) => existsSync(a.file) && readFileSync(a.file, 'utf8').includes(a.expect));
  else if (c.side) ok = process.env.OKPROOF_SIDE === c.side;
  else if (c.exists) ok = existsSync(c.exists);
  else if (existsSync(c.file)) ok = readFileSync(c.file, 'utf8').includes(c.expect);
  return '<testcase name="' + esc(c.name) + '">' + (ok ? '' : '<failure message="no"/>') + '</testcase>';
});
writeFileSync(process.env.OUT || 'results.xml', '<testsuite>' + rows.join('') + '</testsuite>');
`;

const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
delete ENV.GITHUB_ACTIONS;
delete ENV.GITHUB_TOKEN;
delete ENV.GH_TOKEN;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true });
    await writeFile(join(root, p), text);
  }
}

interface Repo {
  root: string;
  runner: string;
  command: string;
}

/** A repo on `main` with `base` files, then branch `feature` with `head` files committed on top. */
async function makeRepo(base: Record<string, string>, head: Record<string, string>): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'okproof-diff-'));
  const runner = join(root, '..', `okproof-runner-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(runner, RUNNER);
  git(root, 'init', '-q');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await put(root, base);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  await put(root, head);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'head');
  return { root, runner, command: `node "${runner.replace(/\\/g, '/')}"` };
}

async function cleanup(r: Repo): Promise<void> {
  await rm(r.root, { recursive: true, force: true });
  await rm(r.runner, { force: true });
}

function okproof(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env: ENV, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function snapshot(root: string) {
  return {
    status: git(root, 'status', '--porcelain'),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branches: git(root, 'branch', '--list').trim(),
    worktrees: git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length,
  };
}

const diffArgs = (r: Repo, extra: string[] = []) => ['diff', '--base', 'main', '--test', r.command, '--results', 'results.xml', ...extra, '.okproof'];

const PROOF_ALL = '## #9 Demo\n- [ ] feature changed\n- [ ] other stable\n- [ ] regress check\n- [ ] never true\n- [ ] side env\n';
const cases = (list: object[]) => JSON.stringify(list);

function scenario() {
  return makeRepo(
    { 'src/feature.txt': 'v1', 'src/other.txt': 'stable', 'src/reg.txt': 'good', '.gitignore': 'results.xml\n' },
    {
      'src/feature.txt': 'v2',
      'src/reg.txt': 'bad',
      '.okproof/9.md': PROOF_ALL,
      'test/cases.json': cases([
        { name: 'feature [okproof:9.1]', file: 'src/feature.txt', expect: 'v2' },
        { name: 'other [okproof:9.2]', file: 'src/other.txt', expect: 'stable' },
        { name: 'reg [okproof:9.3]', file: 'src/reg.txt', expect: 'good' },
        { name: 'never [okproof:9.4]', file: 'src/other.txt', expect: 'nope' },
        { name: 'side [okproof:9.5]', side: 'head' },
      ]),
    },
  );
}

test('classify: the four differential outcomes, plus missing on the base', () => {
  const proof = parseProof('## #1 T\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f\n');
  const t = (n: number, status: string): TestOutcome => ({ title: `t [okproof:1.${n}]`, status });
  const base = [t(2, 'passed'), t(3, 'passed'), t(4, 'failed'), t(1, 'failed')];
  const head = [t(1, 'passed'), t(2, 'passed'), t(3, 'failed'), t(4, 'failed'), t(5, 'passed')];
  const got = Object.fromEntries(classify(proof, base, head).map((c) => [c.id, c.status]));
  assert.deepEqual(got, { '1.1': 'proven-by-change', '1.2': 'not-differential', '1.3': 'regressed', '1.4': 'failing', '1.5': 'proven-by-change', '1.6': 'untested' });
  // No base results at all: everything that passes on HEAD is proven by the change.
  assert.equal(classify(proof, undefined, head)[1]!.status, 'proven-by-change');
  // A flaky pass is not a pass.
  assert.equal(classify(proof, base, [t(2, 'flaky')])[1]!.status, 'regressed');
  assert.equal(classify(proof, undefined, [t(2, 'flaky')])[1]!.status, 'failing');
});

test('classify: {pre} marker and allowPreexisting accept a not-differential criterion', () => {
  const proof = parseProof('## #1 T\n- [ ] {pre} already true\n- [ ] {#x} {pre} stable id too\n- [ ] plain\n');
  const pass = (id: string): TestOutcome => ({ title: `t [okproof:${id}]`, status: 'passed' });
  const out = [pass('1.1'), pass('1.x'), pass('1.3')];
  const got = classify(proof, out, out);
  assert.deepEqual(got.map((c) => [c.status, c.allowed]), [['not-differential', true], ['not-differential', true], ['not-differential', false]]);
  assert.equal(classify(proof, out, out, true)[2]!.allowed, true);
});

test('file kinds: tests, docs, lockfiles and proof files are not source', () => {
  for (const p of ['test/a.ts', 'src/a.test.ts', 'src/a.spec.js', 'pkg/foo_test.go', 'tests/x.py', 'src/test_x.py', 'src/FooTest.java', '__tests__/a.js']) assert.equal(isTestFile(p), true, p);
  for (const p of ['src/a.ts', 'src/latest.ts', 'lib/contest.js', 'src/feature.txt']) assert.equal(isTestFile(p), false, p);
  for (const p of ['src/a.ts', 'lib/x/y.go', 'src/feature.txt']) assert.equal(isSourceFile(p), true, p);
  for (const p of ['README.md', 'docs/x.ts', '.okproof/1.md', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'src/a.test.ts', 'CHANGELOG.md', 'logo.png']) assert.equal(isSourceFile(p), false, p);
});

test('groupFiles: one run per file, then by directory, then all in one', () => {
  const f = (path: string) => ({ status: 'M' as const, path });
  const files = [f('a/x/1.ts'), f('a/x/2.ts'), f('a/y/3.ts'), f('b/4.ts'), f('5.ts')];
  assert.equal(groupFiles(files, 5).length, 5);
  const g3 = groupFiles(files, 3);
  assert.ok(g3.length <= 3);
  assert.equal(g3.flatMap((g) => g.files).length, 5);
  const g1 = groupFiles(files, 1);
  assert.equal(g1.length, 1);
  assert.equal(g1[0]!.files.length, 5);
});

test('okproof diff: proven-by-change, not-differential, regressed, failing, and a side env var', { skip }, async () => {
  const r = await scenario();
  try {
    const before = snapshot(r.root);
    const res = okproof(r.root, diffArgs(r));
    assert.equal(res.status, 1, res.out);
    const file = JSON.parse(await readFile(join(r.root, '.okproof', 'diff-9.json'), 'utf8'));
    const by = Object.fromEntries(file.criteria.map((c: { id: string; status: string }) => [c.id, c.status]));
    assert.deepEqual(by, { '9.1': 'proven-by-change', '9.2': 'not-differential', '9.3': 'regressed', '9.4': 'failing', '9.5': 'proven-by-change' });
    assert.equal(file.head, git(r.root, 'rev-parse', 'HEAD').trim());
    assert.equal(file.base, git(r.root, 'rev-parse', 'main').trim());
    assert.match(file.criteriaHash, /^[0-9a-f]{64}$/);
    // The caller's repository is exactly as it was (the diff file is the only new thing).
    const after = snapshot(r.root);
    assert.equal(after.branch, before.branch);
    assert.equal(after.head, before.head);
    assert.equal(after.branches, before.branches);
    assert.equal(after.worktrees, 1);
    assert.equal(after.status.replace('?? .okproof/diff-9.json\n', ''), before.status.replace('?? .okproof/diff-9.json\n', ''));
    assert.equal(git(r.root, 'show', 'HEAD:src/feature.txt'), 'v2');
  } finally {
    await cleanup(r);
  }
});

test('okproof diff: {pre} and --allow-preexisting make a not-differential criterion acceptable', { skip }, async () => {
  const proof = '## #9 Demo\n- [ ] feature changed\n- [ ] {pre} other stable\n';
  const mk = () =>
    makeRepo(
      { 'src/feature.txt': 'v1', 'src/other.txt': 'stable', '.gitignore': 'results.xml\n' },
      {
        'src/feature.txt': 'v2',
        '.okproof/9.md': proof,
        'test/cases.json': cases([
          { name: 'feature [okproof:9.1]', file: 'src/feature.txt', expect: 'v2' },
          { name: 'other [okproof:9.2]', file: 'src/other.txt', expect: 'stable' },
        ]),
      },
    );
  const r = await mk();
  try {
    const res = okproof(r.root, diffArgs(r));
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /9\.2 {2}not-differential \(allowed\)/);
  } finally {
    await cleanup(r);
  }
  const r2 = await makeRepo(
    { 'src/feature.txt': 'v1', 'src/other.txt': 'stable', '.gitignore': 'results.xml\n' },
    { 'src/feature.txt': 'v2', '.okproof/9.md': proof.replace('{pre} ', ''), 'test/cases.json': cases([{ name: 'other [okproof:9.1]', file: 'src/other.txt', expect: 'stable' }, { name: 'x [okproof:9.2]', file: 'src/feature.txt', expect: 'v2' }]) },
  );
  try {
    assert.equal(okproof(r2.root, diffArgs(r2)).status, 1);
    assert.equal(okproof(r2.root, diffArgs(r2, ['--allow-preexisting'])).status, 0);
  } finally {
    await cleanup(r2);
  }
});

test('gate: fails on not-differential and regressed, passes with {pre} or --allow-preexisting', { skip }, async () => {
  const r = await scenario();
  try {
    assert.equal(okproof(r.root, diffArgs(r)).status, 1);
    // Results of the real HEAD checkout, as CI would have them.
    const run = spawnSync(process.execPath, [r.runner.replace(/\\/g, '/')], { cwd: r.root, env: { ...ENV, OKPROOF_SIDE: 'head' } });
    assert.equal(run.status, 0);
    const gate = okproof(r.root, ['gate', '--results', 'results.xml', '.okproof']);
    assert.equal(gate.status, 1, gate.out);
    assert.match(gate.out, /9\.2 is NOT DIFFERENTIAL/);
    assert.match(gate.out, /9\.3 REGRESSED/);
  } finally {
    await cleanup(r);
  }
  const proof = '## #9 Demo\n- [ ] feature changed\n- [ ] other stable\n';
  const r2 = await makeRepo(
    { 'src/feature.txt': 'v1', 'src/other.txt': 'stable', '.gitignore': 'results.xml\n' },
    { 'src/feature.txt': 'v2', '.okproof/9.md': proof, 'test/cases.json': cases([{ name: 'a [okproof:9.1]', file: 'src/feature.txt', expect: 'v2' }, { name: 'b [okproof:9.2]', file: 'src/other.txt', expect: 'stable' }]) },
  );
  try {
    assert.equal(okproof(r2.root, diffArgs(r2, ['--allow-preexisting'])).status, 0);
    spawnSync(process.execPath, [r2.runner.replace(/\\/g, '/')], { cwd: r2.root, env: ENV });
    // The diff file recorded the allowance, so the gate accepts it.
    assert.equal(okproof(r2.root, ['gate', '--results', 'results.xml', '.okproof']).status, 0);
    // A file written without the allowance fails the gate, unless the gate flag is given.
    assert.equal(okproof(r2.root, diffArgs(r2)).status, 1);
    const strict = okproof(r2.root, ['gate', '--results', 'results.xml', '.okproof']);
    assert.equal(strict.status, 1, strict.out);
    assert.equal(okproof(r2.root, ['gate', '--results', 'results.xml', '--allow-preexisting', '.okproof']).status, 0);
    // Editing the criteria makes the diff results stale.
    await writeFile(join(r2.root, '.okproof', '9.md'), proof + '- [ ] another\n');
    const stale = okproof(r2.root, ['gate', '--results', 'results.xml', '.okproof']);
    assert.equal(stale.status, 1);
    assert.match(stale.out, /differential results are stale/);
  } finally {
    await cleanup(r2);
  }
});

test('ingest records a not-differential criterion as failed in the ledger', { skip }, async () => {
  const r = await scenario();
  try {
    okproof(r.root, diffArgs(r));
    spawnSync(process.execPath, [r.runner.replace(/\\/g, '/')], { cwd: r.root, env: { ...ENV, OKPROOF_SIDE: 'head' } });
    const ing = okproof(r.root, ['ingest', 'results.xml', '.okproof']);
    assert.match(ing.out, /not proven/);
    const ledger = JSON.parse(await readFile(join(r.root, '.okproof', 'ledger-9.json'), 'utf8'));
    const e = ledger.entries.find((x: { id: string }) => x.id === '9.2');
    assert.equal(e.verdict, 'failed');
    assert.equal(ledger.entries.find((x: { id: string }) => x.id === '9.1').verdict, 'met');
  } finally {
    await cleanup(r);
  }
});

test('worktrees are removed and the repo untouched when the test command fails or times out', { skip }, async () => {
  const r = await makeRepo(
    { 'src/feature.txt': 'v1', '.gitignore': 'results.xml\n' },
    { 'src/feature.txt': 'v2', '.okproof/9.md': '## #9 D\n- [ ] x\n', 'test/cases.json': cases([{ name: 'x [okproof:9.1]', file: 'src/feature.txt', expect: 'v2' }]) },
  );
  try {
    const before = snapshot(r.root);
    // Exits non-zero and writes no results file.
    const fail = okproof(r.root, ['diff', '--base', 'main', '--test', `node -e "process.exit(3)"`, '--results', 'results.xml', '.okproof']);
    assert.equal(fail.status, 2, fail.out);
    assert.match(fail.out, /wrote no results file/);
    assert.deepEqual(snapshot(r.root), before);
    // Hangs.
    const slow = okproof(r.root, ['diff', '--base', 'main', '--test', `node -e "setTimeout(()=>{},60000)"`, '--results', 'results.xml', '--timeout', '1', '.okproof']);
    assert.equal(slow.status, 2, slow.out);
    assert.match(slow.out, /timed out/);
    assert.deepEqual(snapshot(r.root), before);
    assert.equal(git(r.root, 'worktree', 'list').trim().split('\n').length, 1);
    await assert.rejects(stat(join(r.root, '.okproof', 'diff-9.json')));
  } finally {
    await cleanup(r);
  }
});

test('the real node_modules is linked into the worktree and survives cleanup', { skip }, async () => {
  const r = await makeRepo(
    { 'src/feature.txt': 'v1', '.gitignore': 'results.xml\nnode_modules/\n' },
    { 'src/feature.txt': 'v2', '.okproof/9.md': '## #9 D\n- [ ] x\n', 'test/cases.json': cases([{ name: 'x [okproof:9.1]', exists: 'node_modules/marker.txt' }]) },
  );
  try {
    await put(r.root, { 'node_modules/marker.txt': 'here' });
    const res = okproof(r.root, diffArgs(r, ['--allow-preexisting']));
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /not-differential \(allowed\)/);
    assert.equal(await readFile(join(r.root, 'node_modules', 'marker.txt'), 'utf8'), 'here');
  } finally {
    await cleanup(r);
  }
});

test('okproof diff: bad input is a clear error', { skip }, async () => {
  const r = await scenario();
  try {
    assert.equal(okproof(r.root, ['diff', '--results', 'results.xml']).status, 2);
    const noBase = okproof(r.root, diffArgs(r).map((a) => (a === 'main' ? 'nonexistent-ref' : a)));
    assert.equal(noBase.status, 2);
    assert.match(noBase.out, /fetch-depth: 0/);
    const flagLike = okproof(r.root, diffArgs(r).map((a) => (a === 'main' ? '--upload-pack=x' : a)));
    assert.equal(flagLike.status, 2);
    const outside = okproof(r.root, ['diff', '--base', 'main', '--test', r.command, '--results', '../escape.xml', '.okproof']);
    assert.equal(outside.status, 2);
    assert.match(outside.out, /inside the repository/);
  } finally {
    await cleanup(r);
  }
});

// ------------------------------------------------------------- revert check

const REVERT_PROOF = '## #9 Demo\n- [ ] a is new\n- [ ] untouched code\n- [ ] needs both files\n';

function revertScenario() {
  return makeRepo(
    { 'src/a/a.txt': 'a1', 'src/b/b.txt': 'b1', 'src/c.txt': 'c1', 'src/k/one.txt': 'x', 'src/k/two.txt': 'y', '.gitignore': 'results.xml\n' },
    {
      'src/a/a.txt': 'a2',
      'src/b/b.txt': 'b2',
      'src/k/one.txt': 'x2',
      'src/k/two.txt': 'y2',
      'README.md': 'docs do not count',
      '.okproof/9.md': REVERT_PROOF,
      'test/cases.json': cases([
        { name: 'a [okproof:9.1]', file: 'src/a/a.txt', expect: 'a2' },
        { name: 'c [okproof:9.2]', file: 'src/c.txt', expect: 'c1' },
        // Passes unless BOTH k files are back at the base.
        { name: 'k [okproof:9.3]', file: 'src/k/one.txt', expect: 'x2' },
      ]),
    },
  );
}

test('okproof revert-check: covered criteria name their files; uncovered ones fail the gate', { skip }, async () => {
  const r = await revertScenario();
  try {
    const before = snapshot(r.root);
    const res = okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '.okproof']);
    assert.equal(res.status, 1, res.out);
    const file = JSON.parse(await readFile(join(r.root, '.okproof', 'revert-9.json'), 'utf8'));
    assert.deepEqual(file.changedSourceFiles, ['src/a/a.txt', 'src/b/b.txt', 'src/k/one.txt', 'src/k/two.txt']);
    const by = Object.fromEntries(file.criteria.map((c: { id: string }) => [c.id, c]));
    assert.equal(by['9.1'].status, 'covered');
    assert.deepEqual(by['9.1'].coveredBy, ['src/a/a.txt']);
    assert.equal(by['9.2'].status, 'uncovered');
    assert.equal(by['9.3'].status, 'covered');
    assert.deepEqual(by['9.3'].coveredBy, ['src/k/one.txt']);
    assert.match(file.criteriaHash, /^[0-9a-f]{64}$/);
    const after = snapshot(r.root);
    assert.deepEqual({ ...after, status: '' }, { ...before, status: '' });
    assert.equal(git(r.root, 'show', 'HEAD:src/a/a.txt'), 'a2');
    // Gate: uncovered fails, --allow-uncovered passes.
    spawnSync(process.execPath, [r.runner.replace(/\\/g, '/')], { cwd: r.root, env: ENV });
    const gate = okproof(r.root, ['gate', '--results', 'results.xml', '.okproof']);
    assert.equal(gate.status, 1, gate.out);
    assert.match(gate.out, /9\.2 is UNCOVERED/);
    assert.equal(okproof(r.root, ['gate', '--results', 'results.xml', '--allow-uncovered', '.okproof']).status, 0);
    // The recorded allowance works too.
    assert.equal(okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '--allow-uncovered', '.okproof']).status, 0);
    assert.equal(okproof(r.root, ['gate', '--results', 'results.xml', '.okproof']).status, 0);
  } finally {
    await cleanup(r);
  }
});

test('okproof revert-check: --max-runs groups files by directory and still attributes coverage', { skip }, async () => {
  const r = await revertScenario();
  try {
    const res = okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '--max-runs', '2', '.okproof']);
    assert.equal(res.status, 1, res.out);
    const file = JSON.parse(await readFile(join(r.root, '.okproof', 'revert-9.json'), 'utf8'));
    // 2 grouped runs at most, plus the combined run when something is still green.
    assert.ok(file.runs.length <= 3, JSON.stringify(file.runs));
    const by = Object.fromEntries(file.criteria.map((c: { id: string }) => [c.id, c]));
    assert.equal(by['9.1'].status, 'covered');
    assert.equal(by['9.2'].status, 'uncovered');
    assert.equal(snapshot(r.root).worktrees, 1);
  } finally {
    await cleanup(r);
  }
});

test('okproof revert-check: a criterion that only notices both files reverted together is covered by the combined run', { skip }, async () => {
  const r = await makeRepo(
    { 'src/p.txt': 'p1', 'src/q.txt': 'q1', '.gitignore': 'results.xml\n' },
    {
      'src/p.txt': 'p2',
      'src/q.txt': 'q2',
      '.okproof/9.md': '## #9 D\n- [ ] either-or\n',
      // Passes while either new value is present, so only reverting both flips it.
      'test/cases.json': cases([{ name: 'p-or-q [okproof:9.1]', any: [{ file: 'src/p.txt', expect: 'p2' }, { file: 'src/q.txt', expect: 'q2' }] }]),
    },
  );
  try {
    const res = okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '.okproof']);
    assert.equal(res.status, 0, res.out);
    const file = JSON.parse(await readFile(join(r.root, '.okproof', 'revert-9.json'), 'utf8'));
    assert.equal(file.criteria[0].status, 'covered');
    assert.deepEqual(file.criteria[0].coveredBy, ['(all changed source files together)']);
    assert.equal(file.runs.length, 3);
  } finally {
    await cleanup(r);
  }
});

test('okproof revert-check: no changed source files means every passing criterion is uncovered', { skip }, async () => {
  const r = await makeRepo(
    { 'src/a.txt': 'a1', '.gitignore': 'results.xml\n' },
    { 'docs/notes.md': 'x', '.okproof/9.md': '## #9 D\n- [ ] x\n', 'test/cases.json': cases([{ name: 'x [okproof:9.1]', file: 'src/a.txt', expect: 'a1' }]) },
  );
  try {
    const res = okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '.okproof']);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /no source files changed/);
  } finally {
    await cleanup(r);
  }
});

test('revert-check: a deleted and an added source file are reverted and restored correctly', { skip }, async () => {
  const r = await makeRepo(
    { 'src/old.txt': 'old', 'src/keep.txt': 'k', '.gitignore': 'results.xml\n' },
    { 'src/new.txt': 'new', '.okproof/9.md': '## #9 D\n- [ ] gone\n- [ ] added\n', 'test/cases.json': cases([{ name: 'gone [okproof:9.1]', file: 'src/old.txt', expect: 'old' }, { name: 'added [okproof:9.2]', file: 'src/new.txt', expect: 'new' }]) },
  );
  try {
    git(r.root, 'rm', '-q', 'src/old.txt');
    git(r.root, 'commit', '-q', '-m', 'delete old');
    const res = okproof(r.root, ['revert-check', '--base', 'main', '--test', r.command, '--results', 'results.xml', '.okproof']);
    // 9.1 passes at HEAD only if old.txt exists: it does not, so it fails at HEAD and is not "uncovered".
    const file = JSON.parse(await readFile(join(r.root, '.okproof', 'revert-9.json'), 'utf8'));
    const by = Object.fromEntries(file.criteria.map((c: { id: string; status: string }) => [c.id, c.status]));
    assert.equal(by['9.1'], 'failing');
    assert.equal(by['9.2'], 'covered');
    assert.equal(res.status, 0, res.out);
  } finally {
    await cleanup(r);
  }
});

test('action.yml: differential and test-command reach the diff step only through env', async () => {
  const yml = (await readFile(fileURLToPath(new URL('../../action.yml', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(yml, /\n {2}differential:\n[\s\S]*?default: 'off'/);
  assert.match(yml, /\n {2}test-command:\n/);
  const step = yml.slice(yml.indexOf('- name: Differential proof'), yml.indexOf('- name: Build ledgers from JUnit XML'));
  assert.match(step, /TEST_COMMAND: \$\{\{ inputs\.test-command \}\}/);
  assert.match(step, /--test "\$TEST_COMMAND"/);
  const run = step.slice(step.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{/);
});
