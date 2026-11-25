// Independent review, round 2: the GitHub Action's option handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface Resolved {
  env: Record<string, string>;
  outputs: Record<string, string>;
  errors: string[];
  warnings: string[];
}
const opts = await import(pathToFileURL(join(root, 'scripts', 'action-options.mjs')).href);
const links = await import(pathToFileURL(join(root, 'scripts', 'action-proof-links.mjs')).href);
const resolve = (e: Record<string, string>, proofFiles = true): Resolved => opts.resolveOptions(e, proofFiles);

test('the gate fails without a results input unless allow-committed-ledgers is true', () => {
  const r = resolve({ GATE: 'true', RESULTS: '' });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /no `results` input/);
  assert.match(r.errors[0]!, /allow-committed-ledgers/);
  const ok = resolve({ GATE: 'true', RESULTS: '', ALLOW_COMMITTED: 'true' });
  assert.deepEqual(ok.errors, []);
  assert.match(ok.warnings.join('\n'), /trusts committed ledger files/);
  assert.deepEqual(resolve({ GATE: 'true', RESULTS: 'junit.xml' }).errors, []);
  assert.deepEqual(resolve({ GATE: 'false', RESULTS: '' }).errors, []);
});

test('strict assertions and strict relevance are on by default and can be relaxed', () => {
  const d = resolve({ RESULTS: 'j.xml' });
  assert.equal(d.env.OKPROOF_STRICT_ASSERTIONS, '1');
  assert.equal(d.env.OKPROOF_STRICT_RELEVANCE, '1');
  assert.equal(d.env.OKPROOF_LINT, 'auto');
  const off = resolve({ RESULTS: 'j.xml', STRICT_ASSERTIONS: 'false', STRICT_RELEVANCE: 'false', LINT: 'tests/**/*.spec.ts', MAX_CLAIMS: '5' });
  assert.equal(off.env.OKPROOF_STRICT_ASSERTIONS, '0');
  assert.equal(off.env.OKPROOF_STRICT_RELEVANCE, '0');
  assert.equal(off.env.OKPROOF_LINT, 'tests/**/*.spec.ts');
  assert.equal(off.env.OKPROOF_MAX_CLAIMS, '5');
});

test('strict assertions with lint off warns that every count-less test is unproven', () => {
  const r = resolve({ RESULTS: 'j.xml', LINT: 'off' });
  assert.match(r.warnings.join('\n'), /strict-assertions is on and lint is off/);
});

test('bad inputs are rejected, and values cannot smuggle a newline into the environment file', () => {
  assert.match(resolve({ RESULTS: 'j.xml', ALLOW_EMPTY: 'yes' }).errors.join('\n'), /allow-empty must be/);
  assert.match(resolve({ RESULTS: 'j.xml', MAX_CLAIMS: '0' }).errors.join('\n'), /max-claims/);
  assert.match(resolve({ RESULTS: 'j.xml', LINT: 'a\nGITHUB_PATH=/x' }).errors.join('\n'), /single line/);
  assert.match(resolve({ RESULTS: 'j.xml', LINT: '--evil' }).errors.join('\n'), /lint must be/);
  assert.match(resolve({ RESULTS: 'j\nx.xml' }).errors.join('\n'), /single line/);
});

test('allow-empty: a PR with no proof files passes; without it nothing changes', () => {
  assert.equal(resolve({ RESULTS: 'j.xml', ALLOW_EMPTY: 'true' }, false).outputs.empty, 'true');
  assert.equal(resolve({ RESULTS: 'j.xml', ALLOW_EMPTY: 'true' }, true).outputs.empty, 'false');
  assert.equal(resolve({ RESULTS: 'j.xml' }, false).outputs.empty, 'false');
  assert.equal(resolve({ RESULTS: 'j.xml', ALLOW_EMPTY: 'true' }).env.OKPROOF_ALLOW_EMPTY, '1');
});

test('require-linked-proof follows require-linked unless set', () => {
  assert.equal(resolve({ RESULTS: 'j.xml' }).env.OKPROOF_REQUIRE_LINKED_PROOF, '1');
  assert.equal(resolve({ RESULTS: 'j.xml', REQUIRE_LINKED: 'false' }).env.OKPROOF_REQUIRE_LINKED_PROOF, '0');
  assert.equal(resolve({ RESULTS: 'j.xml', REQUIRE_LINKED: 'false', REQUIRE_LINKED_PROOF: 'true' }).env.OKPROOF_REQUIRE_LINKED_PROOF, '1');
  assert.equal(resolve({ RESULTS: 'j.xml', REQUIRE_LINKED: 'true', REQUIRE_LINKED_PROOF: 'false' }).env.OKPROOF_REQUIRE_LINKED_PROOF, '0');
});

test('hasProofFiles ignores ledgers and missing folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okp-act-'));
  try {
    assert.equal(opts.hasProofFiles(join(dir, 'nope')), false);
    await writeFile(join(dir, 'ledger-1.md'), 'x');
    await writeFile(join(dir, 'ledger-1.json'), '{}');
    assert.equal(opts.hasProofFiles(dir), false);
    await writeFile(join(dir, '1.md'), 'x');
    assert.equal(opts.hasProofFiles(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('linked-proof: a changed proof file whose issue is not linked is reported', () => {
  const files = [
    { filename: '.okproof/142.md', status: 'modified' },
    { filename: '.okproof/999.md', status: 'added' },
    { filename: '.okproof/55.md', status: 'removed' },
    { filename: '.okproof/ledger-7.md', status: 'added' },
    { filename: '.okproof/repro/7.1.json', status: 'added' },
    { filename: 'src/a.ts', status: 'modified' },
  ];
  assert.deepEqual(links.unlinkedProofFiles(files, '.okproof', [142]), ['.okproof/999.md']);
  assert.deepEqual(links.unlinkedProofFiles(files, './.okproof/', ['142', '999']), []);
  const warn = links.judgeProofLinks({ files, dir: '.okproof', linked: [142], require: false });
  assert.equal(warn.failed, false);
  assert.equal(warn.offenders.length, 1);
  assert.match(warn.messages[0], /not linked/);
  assert.equal(links.judgeProofLinks({ files, dir: '.okproof', linked: [142], require: true }).failed, true);
  assert.equal(links.judgeProofLinks({ files, dir: '.okproof', linked: [142, 999], require: true }).failed, false);
});

test('linked-proof: pull request files are paged through a read-only GET', async () => {
  const calls: string[] = [];
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.txt`, status: 'added' }));
  const fakeFetch = async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const p = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, json: async () => (p === 1 ? page(100) : [{ filename: '.okproof/9.md', status: 'added' }]) };
  };
  const files = await links.listPullFiles({ repo: 'o/r', number: 4, token: 't', apiUrl: 'https://api.test', fetchImpl: fakeFetch });
  assert.equal(files.length, 101);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.startsWith('GET https://api.test/repos/o/r/pulls/4/files')));
  await assert.rejects(() => links.listPullFiles({ repo: 'o/r', number: 4, token: 't', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) }), /403/);
});

test('action.yml exposes the new inputs and calls the scripts', async () => {
  const yml = await readFile(join(root, 'action.yml'), 'utf8');
  for (const name of ['allow-committed-ledgers', 'strict-assertions', 'strict-relevance', 'max-claims', 'allow-empty', 'require-linked-proof', 'require-verify']) {
    assert.match(yml, new RegExp(`\\n {2}${name}:\\n`), name);
  }
  assert.match(yml, /action-options\.mjs/);
  assert.match(yml, /action-proof-links\.mjs/);
  assert.match(yml, /--allow-empty/);
  assert.match(yml, /--require-verify/);
  assert.match(yml, /\n {2}strict-assertions:\n[\s\S]*?default: 'true'/);
  assert.match(yml, /\n {2}allow-committed-ledgers:\n[\s\S]*?default: 'false'/);
});

test('the CLI reads the Action settings from OKPROOF_* variables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okp-actenv-'));
  try {
    await mkdir(join(dir, '.okproof'));
    await writeFile(join(dir, '.okproof', '1.md'), '## #1 Demo\n- [ ] The user can export a report\n');
    await writeFile(join(dir, 'a.spec.ts'), `test('user can export a report [okproof:1.1]', () => { expect(2 + 2).toBe(4); });\n`);
    await writeFile(join(dir, 'junit.xml'), '<testsuite><testcase name="user can export a report [okproof:1.1]" assertions="3"/></testsuite>');
    const run = (env: Record<string, string>) => {
      const e: NodeJS.ProcessEnv = { ...process.env, ...env };
      for (const k of ['GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GH_TOKEN']) delete e[k];
      return spawnSync(process.execPath, [cli, 'gate', '--results', 'junit.xml', '.okproof'], { cwd: dir, env: e, encoding: 'utf8' });
    };
    // No lint: the runner's count (3) stands.
    assert.equal(run({}).status, 0);
    // OKPROOF_LINT=auto: lint sees the constant comparison and overrides the runner's count.
    const r = run({ OKPROOF_LINT: 'auto' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /UNPROVEN|marked weak/);
    assert.equal(run({ OKPROOF_LINT: 'off' }).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with strict assertions a count-less test is unproven unless lint finds a real assertion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okp-actstrict-'));
  try {
    await mkdir(join(dir, '.okproof'));
    await writeFile(join(dir, '.okproof', '1.md'), '## #1 Demo\n- [ ] The user can export a report\n- [ ] The user can delete a report\n');
    await writeFile(
      join(dir, 'a.spec.ts'),
      `test('user can export a report [okproof:1.1]', () => { expect(report.rows).toBe(3); });\n` +
        `test('user can delete a report [okproof:1.2]', () => { report.delete(); });\n`,
    );
    await writeFile(
      join(dir, 'junit.xml'),
      '<testsuite><testcase name="user can export a report [okproof:1.1]"/><testcase name="user can delete a report [okproof:1.2]"/></testsuite>',
    );
    const e: NodeJS.ProcessEnv = { ...process.env, OKPROOF_STRICT_ASSERTIONS: '1', OKPROOF_LINT: 'auto' };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GH_TOKEN']) delete e[k];
    const r = spawnSync(process.execPath, [cli, 'gate', '--results', 'junit.xml', '.okproof'], { cwd: dir, env: e, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(out, /real assertion found/);
    assert.match(out, /1\.2 is UNPROVEN/);
    assert.doesNotMatch(out, /1\.1 is UNPROVEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
