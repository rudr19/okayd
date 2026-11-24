// One source of truth for "proven" (evaluateGate), GitHub robustness, and
// verifier results tied to the proof file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLedger, compareToIssueBody, evaluateGate, finalize, parseProof, publishToGitHub, COMMENT_MARKER } from '../src/index.js';
import { criteriaHash } from '../src/verify/ledger.js';

const PROOF = '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works\n';
const actionOutputs = fileURLToPath(new URL('../../scripts/action-outputs.mjs', import.meta.url));

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-integrity-'));
  await writeFile(join(dir, '7.md'), PROOF);
  return dir;
}

const PASS = [
  { title: 'a [okproof:7.1]', status: 'passed' as const },
  { title: 'b [okproof:7.2]', status: 'passed' as const },
];

/** A fully proven ledger, then the proof file is edited so the ledger is stale but still says proven. */
async function staleProject() {
  const dir = await project();
  await finalize(PASS, { dir, github: false });
  await writeFile(join(dir, '7.md'), '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works, differently\n');
  return dir;
}

function runActionOutputs(dir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DIR: dir };
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [actionOutputs], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('index exports evaluateGate and compareToIssueBody', () => {
  assert.equal(typeof evaluateGate, 'function');
  assert.equal(typeof compareToIssueBody, 'function');
});

test('Action outputs: proven for a fresh ledger, not proven for a stale one that says proven', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    assert.match(runActionOutputs(dir).out, /^proven=true$/m);

    await writeFile(join(dir, '7.md'), '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works, differently\n');
    const ledger = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'ledger-7.json'), 'utf8'));
    assert.equal(ledger.proven, true, 'the ledger itself still claims proven');
    const r = runActionOutputs(dir);
    assert.match(r.out, /^proven=false$/m);
    assert.match(r.out, /STALE/);
    assert.equal(r.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Action outputs: no proof files is not proven', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-integrity-'));
  try {
    assert.match(runActionOutputs(dir).out, /^proven=false$/m);
    assert.match(runActionOutputs(join(dir, 'missing')).out, /^proven=false$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the PR comment headline follows the gate, not ledger.proven', async () => {
  const dir = await staleProject();
  try {
    const gate = await evaluateGate(dir);
    assert.equal(gate.ok, false);
    const posted: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      if (init?.method) posted.push(JSON.parse(init.body as string).body);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const stale = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'ledger-7.json'), 'utf8'));
    await publishToGitHub([stale], { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' }, fake, gate);
    assert.match(posted[0]!, /not proven yet/);
    assert.match(posted[0]!, /STALE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const ENV = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' };
const ledger = buildLedger(parseProof(PROOF), PASS);

test('a network error is a skipped comment, not an exception', async () => {
  const boom = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const r = await publishToGitHub([ledger], ENV, boom);
  assert.equal(r.comment, 'skipped');
  assert.match(r.reason ?? '', /fetch failed/);
});

test('an unwritable job summary is a skipped comment, not an exception', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-integrity-'));
  try {
    const r = await publishToGitHub([ledger], { ...ENV, GITHUB_STEP_SUMMARY: join(dir, 'no', 'such', 'dir', 's.md') }, (async () => new Response('[]')) as unknown as typeof fetch);
    assert.equal(r.comment, 'skipped');
    assert.match(r.reason ?? '', /job summary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('finds our comment on page 2 of 150 and updates it instead of posting a duplicate', async () => {
  const all = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: i === 120 ? `${COMMENT_MARKER}\nold` : `chatter ${i}` }));
  const calls: Array<{ url: string; method: string }> = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method) return new Response('{}', { status: 200 });
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return new Response(JSON.stringify(all.slice((page - 1) * 100, page * 100)), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await publishToGitHub([ledger], ENV, fake);
  assert.equal(r.comment, 'updated');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/issues/comments/121')));
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('stops paging early once the comment is found', async () => {
  const gets: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    if (init?.method) return new Response('{}', { status: 200 });
    gets.push(url);
    const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: i === 3 ? `${COMMENT_MARKER}\nold` : 'x' }));
    return new Response(JSON.stringify(first), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await publishToGitHub([ledger], ENV, fake)).comment, 'updated');
  assert.equal(gets.length, 1);
});

test('gives up after 10 pages and posts a new comment', async () => {
  let gets = 0;
  const fake = (async (_url: string, init?: RequestInit) => {
    if (init?.method) return new Response('{}', { status: 200 });
    gets++;
    return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'x' }))), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await publishToGitHub([ledger], ENV, fake)).comment, 'created');
  assert.equal(gets, 10);
});

test('verifier results written for other criteria are stale: gate fails, finalize ignores them', async () => {
  const dir = await project();
  try {
    const stale = { issue: '7', title: 'Demo', baseUrl: 'x', criteriaHash: 'deadbeef', results: [] };
    await writeFile(join(dir, 'verify-7.json'), JSON.stringify(stale));
    const { lines } = await finalize(PASS, { dir, github: false });
    assert.ok(lines.some((l) => /verifier results are stale/.test(l)));
    const gate = await evaluateGate(dir);
    assert.equal(gate.ok, false);
    assert.match(gate.problems.join('\n'), /verifier results are stale; re-run okproof verify or delete the file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a verify file without a hash is stale; a matching hash passes and is applied', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    await writeFile(join(dir, 'verify-7.json'), JSON.stringify({ issue: '7', title: 'Demo', baseUrl: 'x', results: [] }));
    assert.equal((await evaluateGate(dir)).ok, false);

    const proof = parseProof(PROOF);
    const refuted = {
      criterionId: '7.1', criterion: 'x', verdict: 'refuted', outcome: 'concluded', steps: 1, usage: { input: 0, output: 0 },
      findings: [{ kind: 'violation', title: 'Broken', severity: 3, confirmed: true }], actions: [], screenshots: [],
    };
    await writeFile(join(dir, 'verify-7.json'), JSON.stringify({ issue: '7', title: 'Demo', baseUrl: 'x', criteriaHash: criteriaHash(proof), results: [refuted] }));
    const { ledgers } = await finalize(PASS, { dir, github: false });
    assert.equal(ledgers[0]!.entries[0]!.verdict, 'failed', 'a current refutation still applies');
    const gate = await evaluateGate(dir);
    assert.equal(gate.ok, false);
    assert.doesNotMatch(gate.problems.join('\n'), /stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editing the proof file invalidates the verify file hash', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    await writeFile(join(dir, 'verify-7.json'), JSON.stringify({ issue: '7', title: 'Demo', baseUrl: 'x', criteriaHash: criteriaHash(parseProof(PROOF)), results: [] }));
    assert.equal((await evaluateGate(dir)).ok, true);
    await writeFile(join(dir, '7.md'), '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works\n- [ ] Third\n');
    const gate = await evaluateGate(dir);
    assert.equal(gate.ok, false);
    assert.match(gate.problems.join('\n'), /verifier results are stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repro file with no verify file is a note, not a failure', async () => {
  const dir = await project();
  try {
    await finalize(PASS, { dir, github: false });
    await mkdir(join(dir, 'repro'));
    await writeFile(join(dir, 'repro', '7.2.json'), '{}');
    const gate = await evaluateGate(dir);
    assert.equal(gate.ok, true, gate.problems.join('\n'));
    assert.match(gate.notes.join('\n'), /repro file exists for 7\.2 but verify-7\.json is missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
