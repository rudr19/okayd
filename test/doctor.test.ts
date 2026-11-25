import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIgnored, patternMatches, repoFromRemote, runDoctor } from '../src/doctor.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const WORKFLOW = `name: okproof
on: pull_request
jobs:
  prove:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rudr19/okproof@v0
        with:
          results: junit.xml
`;

async function repo(files: Record<string, string | undefined>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okp-doc-'));
  for (const [rel, text] of Object.entries(files)) {
    if (text === undefined) continue;
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, text);
  }
  return root;
}

const GOOD = {
  '.github/CODEOWNERS': '* @team\n/.okproof/ @security\n',
  '.gitignore': 'node_modules\n.okproof/ledger-*\n',
  '.github/workflows/okproof.yml': WORKFLOW,
};

interface Call {
  method: string;
  url: string;
  auth: boolean;
}
function fakeGitHub(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ method: init?.method ?? 'GET', url, auth: Boolean(init?.headers?.authorization) });
    const path = new URL(url).pathname;
    const r = routes[path] ?? { status: 404, body: { message: 'Not Found' } };
    return { status: r.status, ok: r.status < 300, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PROTECTED = {
  '/repos/o/r': { status: 200, body: { default_branch: 'main' } },
  '/repos/o/r/rules/branches/main': { status: 200, body: [] },
  '/repos/o/r/branches/main/protection': {
    status: 200,
    body: { required_status_checks: { contexts: ['prove'], checks: [] }, required_pull_request_reviews: { require_code_owner_reviews: true } },
  },
};

const level = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.filter((c) => c.id === id).map((c) => c.level);

test('doctor: a well protected repository passes every check, using GET only', async () => {
  const cwd = await repo(GOOD);
  try {
    const gh = fakeGitHub(PROTECTED);
    const r = await runDoctor({ cwd, repo: 'o/r', fetchImpl: gh.impl, token: 'secret-token' });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.deepEqual(r.checks.map((c) => c.level).filter((l) => l !== 'pass'), []);
    assert.ok(gh.calls.length >= 3);
    assert.ok(gh.calls.every((c) => c.method === 'GET' && c.auth));
    assert.ok(!r.lines.join('\n').includes('secret-token'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('doctor: no CODEOWNERS, or a CODEOWNERS that does not cover .okproof, fails', async () => {
  const none = await repo({ ...GOOD, '.github/CODEOWNERS': undefined });
  const uncovered = await repo({ ...GOOD, '.github/CODEOWNERS': '/src/ @team\n' });
  const unowned = await repo({ ...GOOD, '.github/CODEOWNERS': '* @team\n/.okproof/\n' });
  const overridden = await repo({ ...GOOD, '.github/CODEOWNERS': '/.okproof/ @security\n*.md @docs\n' });
  try {
    assert.deepEqual(level(await runDoctor({ cwd: none }), 'codeowners'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: uncovered }), 'codeowners'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: unowned }), 'codeowners'), ['fail']);
    // The last matching rule wins, so *.md @docs takes .okproof/x.md away from @security: still owned, so it passes.
    assert.deepEqual(level(await runDoctor({ cwd: overridden }), 'codeowners'), ['pass']);
  } finally {
    for (const d of [none, uncovered, unowned, overridden]) await rm(d, { recursive: true, force: true });
  }
});

test('doctor: ledgers not ignored is a warning', async () => {
  const cwd = await repo({ ...GOOD, '.gitignore': 'node_modules\n' });
  const negated = await repo({ ...GOOD, '.gitignore': '.okproof/ledger-*\n!.okproof/ledger-1.json\n' });
  try {
    assert.deepEqual(level(await runDoctor({ cwd }), 'gitignore'), ['warn']);
    assert.deepEqual(level(await runDoctor({ cwd: negated }), 'gitignore'), ['warn']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(negated, { recursive: true, force: true });
  }
});

test('doctor: the workflow must pass results and, with differential, fetch history', async () => {
  const noResults = await repo({ ...GOOD, '.github/workflows/okproof.yml': WORKFLOW.replace('          results: junit.xml\n', '          dir: .okproof\n') });
  const committedOk = await repo({ ...GOOD, '.github/workflows/okproof.yml': WORKFLOW.replace('results: junit.xml', 'allow-committed-ledgers: true') });
  const none = await repo({ ...GOOD, '.github/workflows/okproof.yml': 'name: x\non: push\njobs: {}\n' });
  const cliGate = await repo({ ...GOOD, '.github/workflows/okproof.yml': 'jobs:\n  a:\n    steps:\n      - run: npx okproof gate --results junit.xml\n' });
  const cliNoResults = await repo({ ...GOOD, '.github/workflows/okproof.yml': 'jobs:\n  a:\n    steps:\n      - run: npx okproof gate\n' });
  const diffShallow = await repo({ ...GOOD, '.github/workflows/okproof.yml': WORKFLOW.replace('          results: junit.xml\n', '          results: junit.xml\n          differential: true\n') });
  const diffDeep = await repo({
    ...GOOD,
    '.github/workflows/okproof.yml': WORKFLOW.replace('      - uses: actions/checkout@v4\n', '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n').replace('          results: junit.xml\n', '          results: junit.xml\n          differential: true\n'),
  });
  try {
    assert.deepEqual(level(await runDoctor({ cwd: noResults }), 'workflow'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: committedOk }), 'workflow'), ['warn']);
    assert.deepEqual(level(await runDoctor({ cwd: none }), 'workflow'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: cliGate }), 'workflow'), ['pass']);
    assert.deepEqual(level(await runDoctor({ cwd: cliNoResults }), 'workflow'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: diffShallow }), 'fetch-depth'), ['fail']);
    assert.deepEqual(level(await runDoctor({ cwd: diffDeep }), 'fetch-depth'), ['pass']);
    assert.deepEqual(level(await runDoctor({ cwd: noResults }), 'fetch-depth'), []);
  } finally {
    for (const d of [noResults, committedOk, none, cliGate, cliNoResults, diffShallow, diffDeep]) await rm(d, { recursive: true, force: true });
  }
});

test('doctor: branch protection without the okproof check or code-owner review fails', async () => {
  const cwd = await repo(GOOD);
  try {
    const weak = fakeGitHub({
      ...PROTECTED,
      '/repos/o/r/branches/main/protection': { status: 200, body: { required_status_checks: { contexts: ['build'] }, required_pull_request_reviews: { require_code_owner_reviews: false } } },
    });
    const r = await runDoctor({ cwd, repo: 'o/r', fetchImpl: weak.impl });
    assert.equal(r.ok, false);
    assert.deepEqual(level(r, 'required-check'), ['fail']);
    assert.deepEqual(level(r, 'codeowner-review'), ['fail']);
    const none = fakeGitHub({ ...PROTECTED, '/repos/o/r/branches/main/protection': { status: 404, body: { message: 'Branch not protected' } } });
    assert.equal((await runDoctor({ cwd, repo: 'o/r', fetchImpl: none.impl })).ok, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('doctor: rulesets count, and --check pins the required job name', async () => {
  const cwd = await repo(GOOD);
  try {
    const gh = fakeGitHub({
      '/repos/o/r': { status: 200, body: { default_branch: 'main' } },
      '/repos/o/r/rules/branches/main': {
        status: 200,
        body: [
          { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'okproof / prove' }] } },
          { type: 'pull_request', parameters: { require_code_owner_review: true } },
        ],
      },
      '/repos/o/r/branches/main/protection': { status: 403, body: { message: 'Resource not accessible' } },
    });
    const r = await runDoctor({ cwd, repo: 'o/r', fetchImpl: gh.impl });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.equal((await runDoctor({ cwd, repo: 'o/r', fetchImpl: gh.impl, check: 'prove' })).ok, true);
    const wrong = await runDoctor({ cwd, repo: 'o/r', fetchImpl: gh.impl, check: 'other' });
    // classic protection was unreadable, so this is a warning to check by hand, not a failure
    assert.deepEqual(level(wrong, 'required-check'), ['warn']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('doctor: an unreadable repository or no token only warns', async () => {
  const cwd = await repo(GOOD);
  try {
    const gh = fakeGitHub({});
    const r = await runDoctor({ cwd, repo: 'o/r', fetchImpl: gh.impl });
    assert.equal(r.ok, true);
    assert.deepEqual(level(r, 'github'), ['warn']);
    const noRepo = await runDoctor({ cwd });
    assert.deepEqual(level(noRepo, 'github'), ['warn']);
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    assert.deepEqual(level(await runDoctor({ cwd, repo: 'o/r', fetchImpl: boom }), 'github'), ['warn']);
    assert.deepEqual(level(await runDoctor({ cwd, repo: 'not a repo' }), 'github'), ['fail']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('doctor: patterns behave like CODEOWNERS and .gitignore', () => {
  assert.ok(patternMatches('/.okproof/', '.okproof/1.md'));
  assert.ok(patternMatches('.okproof', '.okproof/1.md'));
  assert.ok(patternMatches('*', '.okproof/1.md'));
  assert.ok(patternMatches('*.md', '.okproof/1.md'));
  assert.ok(patternMatches('/.okproof/**', '.okproof/1.md'));
  assert.ok(!patternMatches('/src/', '.okproof/1.md'));
  assert.ok(!patternMatches('/okproof/', 'x/okproof/1.md'));
  assert.ok(patternMatches('okproof/', 'x/okproof/1.md'));
  assert.ok(isIgnored('.okproof/ledger-*', '.okproof/ledger-9.json'));
  assert.ok(!isIgnored('', '.okproof/ledger-9.json'));
  assert.ok(!patternMatches('a'.repeat(600), 'a')); // over the glob limit: no match, no throw
});

test('doctor: repoFromRemote drops credentials and rejects other hosts', () => {
  assert.equal(repoFromRemote('https://rudr19@github.com/rudr19/okproof.git\n'), 'rudr19/okproof');
  assert.equal(repoFromRemote('https://github.com/o/r'), 'o/r');
  assert.equal(repoFromRemote('git@github.com:o/r.git'), 'o/r');
  assert.equal(repoFromRemote('https://example.com/o/r.git'), undefined);
  assert.equal(repoFromRemote('nonsense'), undefined);
});

test('okproof doctor --no-network runs offline and exits 1 on a failure', async () => {
  const bad = await repo({ '.gitignore': '' });
  const good = await repo(GOOD);
  try {
    const run = (cwd: string) => spawnSync(process.execPath, [cli, 'doctor', '--no-network'], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' } });
    const b = run(bad);
    assert.equal(b.status, 1, b.stdout + b.stderr);
    assert.match(b.stdout, /FAIL .*CODEOWNERS/);
    const g = run(good);
    assert.equal(g.status, 0, g.stdout + g.stderr);
    assert.match(g.stdout, /PASS/);
    assert.match(g.stdout, /okproof doctor: \d+ passed/);
  } finally {
    await rm(bad, { recursive: true, force: true });
    await rm(good, { recursive: true, force: true });
  }
});
