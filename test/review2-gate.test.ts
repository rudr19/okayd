// Independent review, round 2: gate bypasses (deleted verifier file, placeholder proof file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate } from '../src/gate.js';
import { finalize } from '../src/finalize.js';
import { parseProof } from '../src/proof.js';
import { parseGateArgs } from '../src/trust.js';
import { runInit } from '../src/init.js';
import { syncProofFile } from '../src/sync.js';

const PASS = [
  { title: 'a [okproof:7.1]', status: 'passed', assertions: 1 },
  { title: 'b [okproof:7.2]', status: 'passed', assertions: 1 },
];

async function project(heading = '## #7 Demo'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okp-r2-'));
  const dir = join(root, '.okproof');
  await mkdir(dir);
  await writeFile(join(dir, '7.md'), `${heading}\n- [ ] First thing works\n- [ ] Second thing works\n`);
  await finalize(PASS, { dir, github: false });
  return dir;
}

test('a repro for any criterion of the issue makes a missing verify file fail', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'repro'));
    await writeFile(join(dir, 'repro', '7.deleted-criterion.json'), '{}');
    await writeFile(join(dir, 'repro', '8.1.json'), '{}'); // another issue: irrelevant
    const g = await evaluateGate(dir);
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /verify-7\.json is missing/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a repro for a different issue does not affect this one', async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, 'repro'));
    await writeFile(join(dir, 'repro', '70.1.json'), '{}'); // prefix "7" but issue 70
    assert.equal((await evaluateGate(dir)).ok, true);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('{verify} in the heading requires verify-<n>.json', async () => {
  const dir = await project('## #7 Demo {verify}');
  try {
    assert.equal(parseProof(await readFile(join(dir, '7.md'), 'utf8')).title, 'Demo');
    const g = await evaluateGate(dir);
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /\{verify\}.*verify-7\.json is missing/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('--require-verify / requireVerify requires the verify file for every proof file', async () => {
  const dir = await project();
  try {
    assert.equal(parseGateArgs(['--require-verify', dir]).requireVerify, true);
    assert.equal((await evaluateGate(dir)).ok, true);
    const g = await evaluateGate(dir, { requireVerify: true });
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /--require-verify/);
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('sync keeps {verify} when it rewrites the heading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okp-r2s-'));
  try {
    const dir = '.okproof';
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, '7.md'), '## #7 Demo {verify}\n- [ ] First\n');
    await syncProofFile({ cwd: root, dir, issue: 7, title: 'Demo', body: '- [ ] First\n- [ ] Second\n', write: true });
    const text = await readFile(join(root, dir, '7.md'), 'utf8');
    assert.match(text, /^## #7 Demo \{verify\}\n/);
    assert.equal(parseProof(text).criteria.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the placeholder proof file from init fails the gate until it is edited', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okp-r2i-'));
  try {
    await runInit({ cwd, issue: '5', title: 'Thing' });
    const dir = join(cwd, '.okproof');
    assert.equal(parseProof(await readFile(join(dir, '5.md'), 'utf8')).placeholder, true);
    await finalize([{ title: 'x [okproof:5.1]', status: 'passed', assertions: 2 }], { dir, github: false });
    const g = await evaluateGate(dir);
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /replace the example criteria/);
    await writeFile(join(dir, '5.md'), '## #5 Thing\n- [ ] Real criterion\n');
    await finalize([{ title: 'x [okproof:5.1]', status: 'passed', assertions: 2 }], { dir, github: false });
    assert.equal((await evaluateGate(dir)).ok, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the default init example (no issue) is a placeholder too', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okp-r2j-'));
  try {
    await runInit({ cwd });
    const g = await evaluateGate(join(cwd, '.okproof'));
    assert.equal(g.ok, false);
    assert.match(g.problems.join('\n'), /replace the example criteria/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('docs state the trust model up front and qualify the real-assertion claim', async () => {
  const root = new URL('../../', import.meta.url);
  const trust = await readFile(new URL('docs/trust.md', root), 'utf8');
  assert.match(trust.slice(0, 900), /CODEOWNERS plus required review/);
  assert.match(trust.slice(0, 900), /okproof doctor/);
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const intro = readme.slice(readme.indexOf('"Proves" is the promise'), readme.indexOf('## Quick start'));
  assert.match(intro, /as far as okproof can\s+tell/);
  assert.match(intro, /heuristic/);
  assert.match(readme, /\*\*Your agent says it's done\. okproof proves it, criterion by criterion\.\*\*/);
});
