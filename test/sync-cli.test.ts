import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function setup(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-sync-cli-'));
  await writeFile(join(cwd, 'issue.md'), body);
  const run = (...a: string[]) => spawnSync(process.execPath, [cli, 'sync', ...a], { cwd, encoding: 'utf8' });
  return { cwd, run };
}

test('sync --body-file writes the proof file, titled from the first heading', async () => {
  const { cwd, run } = await setup('# Pro upgrade\n\n- [ ] one\n- [ ] two\n');
  const r = run('--issue', '12', '--body-file', 'issue.md');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /#12: proof file created/);
  assert.equal(await readFile(join(cwd, '.okproof', '12.md'), 'utf8'), '## #12 Pro upgrade\n- [ ] one\n- [ ] two\n');
  const again = run('--issue', '12', '--body-file', 'issue.md', '--check');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /in sync/);
});

test('sync --check exits 1 on drift, changes nothing, and says how to fix it', async () => {
  const { cwd, run } = await setup('# T\n- [ ] one\n- [ ] two\n');
  assert.equal(run('--issue', '3', '--body-file', 'issue.md').status, 0);
  await writeFile(join(cwd, 'issue.md'), '# T\n- [ ] one\n- [ ] three\n');
  const r = run('--issue', '3', '--body-file', 'issue.md', '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /proof file is out of date with issue #3; run okproof sync/);
  assert.equal(await readFile(join(cwd, '.okproof', '3.md'), 'utf8'), '## #3 T\n- [ ] one\n- [ ] two\n');
  // Missing file also counts as drift in check mode.
  assert.equal(run('--issue', '4', '--body-file', 'issue.md', '--check').status, 1);
});

test('sync warns about renumbered ids when a middle criterion is removed', async () => {
  const { cwd, run } = await setup('# T\n- [ ] a\n- [ ] b\n- [ ] c\n');
  run('--issue', '5', '--body-file', 'issue.md');
  await writeFile(join(cwd, 'issue.md'), '# T\n- [ ] a\n- [ ] c\n');
  const r = run('--issue', '5', '--body-file', 'issue.md');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /warning:.*renumbered/);
  assert.match(r.stderr, /\[okproof:5\.3\] -> \[okproof:5\.2\] c/);
});

test('sync usage errors exit 2', async () => {
  const { run } = await setup('# T\n- [ ] a\n');
  assert.equal(run('--body-file', 'issue.md').status, 2);
  assert.equal(run('--issue', '0', '--body-file', 'issue.md').status, 2);
  assert.equal(run('--issue', '1', '--bogus', 'x').status, 2);
  assert.equal(run('--issue', '1', '--body-file', 'issue.md', '../outside').status, 2);
  const noRepo = spawnSync(process.execPath, [cli, 'sync', '--issue', '1'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } });
  assert.equal(noRepo.status, 2);
});
