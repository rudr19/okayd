// Audit gap 4: the merge gate must treat the proof files as the source of
// truth. A ledger alone is only a cache of one test run, so deleting or
// editing a criterion, or having nothing to prove, must never pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function okproof(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const PROOF = '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works\n';
const JUNIT = '<testsuite><testcase name="a [okproof:7.1]"/><testcase name="b [okproof:7.2]"/></testsuite>';

/** A project whose proof file is fully proven by a real `okproof ingest`. */
async function proven() {
  const root = await mkdtemp(join(tmpdir(), 'okproof-gate-'));
  const dir = join(root, '.okproof');
  await mkdir(dir);
  await writeFile(join(dir, '7.md'), PROOF);
  const xml = join(root, 'junit.xml');
  await writeFile(xml, JUNIT);
  const ing = okproof(['ingest', xml, dir]);
  assert.match(ing.out, /2\/2 criteria met, proven/);
  return { root, dir };
}

test('baseline: a proven ledger that matches its proof file passes the gate', async () => {
  const { root, dir } = await proven();
  try {
    assert.equal(okproof(['gate', dir]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4a: deleting a criterion from the proof file fails the gate as stale', async () => {
  const { root, dir } = await proven();
  try {
    await writeFile(join(dir, '7.md'), '## #7 Demo\n- [ ] First thing works\n');
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /stale/i);
    assert.match(r.out, /re-run/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4a: adding or editing a criterion after the ledger was written fails as stale', async () => {
  const { root, dir } = await proven();
  try {
    await writeFile(join(dir, '7.md'), PROOF + '- [ ] Third thing works\n');
    const added = okproof(['gate', dir]);
    assert.equal(added.status, 1, added.out);
    assert.match(added.out, /stale/i);

    await writeFile(join(dir, '7.md'), '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works differently\n');
    const edited = okproof(['gate', dir]);
    assert.equal(edited.status, 1, edited.out);
    assert.match(edited.out, /stale/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4b: no .okproof directory fails with a clear message, unless --allow-empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-gate-'));
  try {
    const missing = join(root, '.okproof');
    const r = okproof(['gate', missing]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no proof files|nothing to prove/i);
    assert.equal(okproof(['gate', missing, '--allow-empty']).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4b: an empty .okproof directory fails, unless --allow-empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-gate-'));
  try {
    const dir = join(root, '.okproof');
    await mkdir(dir);
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no proof files|nothing to prove/i);
    assert.equal(okproof(['gate', dir, '--allow-empty']).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4c: a proof file with no ledger fails even when another proof file has one', async () => {
  const { root, dir } = await proven();
  try {
    await writeFile(join(dir, '8.md'), '## #8 Other\n- [ ] Never tested\n');
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#8/);
    assert.match(r.out, /no ledger/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4c: a proof file with no ledger at all fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-gate-'));
  try {
    const dir = join(root, '.okproof');
    await mkdir(dir);
    await writeFile(join(dir, '7.md'), PROOF);
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no ledger/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4d: the verdict comes from ledger entries, never the proven field alone', async () => {
  const { root, dir } = await proven();
  try {
    const path = join(dir, 'ledger-7.json');
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    ledger.entries[1].verdict = 'untested';
    ledger.proven = true; // forged or out of date
    await writeFile(path, JSON.stringify(ledger));
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /7\.2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('4d: a ledger whose proof file was deleted is an orphan and fails', async () => {
  const { root, dir } = await proven();
  try {
    await writeFile(join(dir, '8.md'), '## #8 Other\n- [ ] Other thing\n');
    await writeFile(join(dir, 'ledger-8.json'), JSON.stringify({ issue: '8', title: 'Other', entries: [{ id: '8.1', text: 'Other thing', verdict: 'met', tests: [] }], proven: true }));
    await rm(join(dir, '8.md'));
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#8/);
    assert.match(r.out, /no proof file/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
