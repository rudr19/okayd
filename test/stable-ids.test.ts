// Audit gap 10: positional ids shift when a criterion is inserted or removed.
// A criterion may carry a stable id: "- [ ] {#login} A user can sign in" is 142.login.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimedCriteria, issueBodyCriteria, parseProof } from '../src/proof.js';
import { buildLedger } from '../src/ledger.js';
import { evaluateGate } from '../src/gate.js';
import { syncProofFile, proofFromIssue } from '../src/sync.js';
import { lintTests } from '../src/lint.js';
import { runTool, tools } from '../src/mcp/tools.js';

const PROOF = '## #142 Auth\n- [ ] {#login} A user can sign in\n- [ ] Plain positional criterion\n- [ ] {#sign-out} A user can sign out\n';

test('a {#id} prefix makes a stable id; lines without one stay positional', () => {
  const p = parseProof(PROOF);
  assert.deepEqual(p.criteria.map((c) => c.id), ['142.login', '142.2', '142.sign-out']);
  assert.equal(p.criteria[0]!.text, 'A user can sign in');
  assert.deepEqual(p.criteria.map((c) => c.index), [1, 2, 3]);
});

test('stable ids are validated: [a-z0-9-] only, unique, not purely numeric, with text', () => {
  const bad = (line: string, re: RegExp) => assert.throws(() => parseProof(`## #1 T\n${line}\n`), re);
  bad('- [ ] {#Login} x', /a-z, 0-9/);
  bad('- [ ] {#log_in} x', /a-z, 0-9/);
  bad('- [ ] {#} x', /a-z, 0-9/);
  bad('- [ ] {#2} x', /letter/);
  bad('- [ ] {#login}', /text/);
  assert.throws(() => parseProof('## #1 T\n- [ ] {#a} x\n- [ ] {#a} y\n'), /duplicate criterion id "a"/);
});

test('tags with stable ids are claimed, and positional tags still are', () => {
  assert.deepEqual(claimedCriteria('works [okproof:142.login] and [okproof:142.2]'), ['142.login', '142.2']);
  assert.deepEqual(claimedCriteria('nope [okproof:142.Login] [okproof:142.log_in]'), []);
});

test('the ledger resolves string ids, and the gate stays green', async () => {
  const proof = parseProof(PROOF);
  const ledger = buildLedger(proof, [
    { title: 'a [okproof:142.login]', status: 'passed', assertions: 1 },
    { title: 'b [okproof:142.2]', status: 'passed', assertions: 1 },
    { title: 'c [okproof:142.sign-out]', status: 'failed' },
  ]);
  assert.deepEqual(ledger.entries.map((e) => [e.id, e.verdict]), [['142.login', 'met'], ['142.2', 'met'], ['142.sign-out', 'failed']]);
  const root = await mkdtemp(join(tmpdir(), 'okproof-ids-'));
  try {
    await writeFile(join(root, '142.md'), PROOF);
    const ok = buildLedger(proof, proof.criteria.map((c) => ({ title: `t [okproof:${c.id}]`, status: 'passed', assertions: 1 })));
    assert.equal((await evaluateGate(root, { ledgers: [ok] })).ok, true);
    const gate = await evaluateGate(root, { ledgers: [ledger] });
    assert.match(gate.problems.join('\n'), /criterion 142\.sign-out is failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an issue body {#id} is not part of the criterion text', () => {
  assert.deepEqual(issueBodyCriteria('- [ ] {#login} A user can sign in\n- [ ] other'), ['A user can sign in', 'other']);
});

test('sync preserves {#id} when it rewrites the proof file, and does not call it drift', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-ids-'));
  try {
    await mkdir(join(cwd, '.okproof'));
    await writeFile(join(cwd, '.okproof', '142.md'), PROOF);
    const body = '- [ ] A user can sign in\n- [ ] Plain positional criterion\n- [ ] A user can sign out\n';
    const same = await syncProofFile({ cwd, dir: '.okproof', issue: 142, title: 'Auth', body });
    assert.equal(same.changed, false);
    assert.deepEqual(same.unchanged.map((u) => u.id), ['142.login', '142.2', '142.sign-out']);

    // The issue drops the middle criterion and gains a new one: ids with {#} do not move.
    const next = '- [ ] A user can sign in\n- [ ] A user can sign out\n- [ ] Brand new\n';
    const r = await syncProofFile({ cwd, dir: '.okproof', issue: 142, title: 'Auth', body: next });
    assert.equal(r.changed, true);
    assert.deepEqual(r.renumbered, []);
    const written = await readFile(join(cwd, '.okproof', '142.md'), 'utf8');
    assert.equal(written, '## #142 Auth\n- [ ] {#login} A user can sign in\n- [ ] {#sign-out} A user can sign out\n- [ ] Brand new\n');
    assert.deepEqual(parseProof(written).criteria.map((c) => c.id), ['142.login', '142.sign-out', '142.3']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an id written in the issue body is adopted by sync', async () => {
  const out = proofFromIssue({ issue: 9, title: 'T', body: '- [ ] {#a-b} First\n- [ ] Second' });
  assert.equal(out, '## #9 T\n- [ ] {#a-b} First\n- [ ] Second\n');
  assert.throws(() => proofFromIssue({ issue: 9, title: 'T', body: '- [ ] {#Bad} First' }), /a-z, 0-9/);
});

test('lint knows stable-id tags: not dangling, and untested ones are listed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-ids-'));
  try {
    await mkdir(join(root, '.okproof'));
    await writeFile(join(root, '.okproof', '142.md'), PROOF);
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'tests', 'a.spec.ts'), "test('sign in [okproof:142.login]', async () => {\n  expect(1).toBe(1);\n});\ntest('ghost [okproof:142.nope]', async () => {\n  expect(1).toBe(1);\n});\n");
    const r = await lintTests({ dir: root, tests: 'tests' });
    const text = r.lines.join('\n');
    assert.match(text, /DANGLING .*\[okproof:142\.nope\]/);
    assert.doesNotMatch(text, /DANGLING .*142\.login/);
    assert.match(text, /UNTESTED  142\.sign-out/);
    assert.doesNotMatch(text, /UNTESTED  142\.login/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP: okproof_criteria shows stable tags and okproof_add_criterion reports the stable id it was given', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-ids-'));
  try {
    await mkdir(join(cwd, '.okproof'));
    await writeFile(join(cwd, '.okproof', '142.md'), PROOF);
    const call = async (name: string, args: Record<string, unknown>) => (await runTool(tools.find((t) => t.name === name)!, args, { cwd })).content[0].text;
    assert.match(await call('okproof_criteria', { issue: '142' }), /\[okproof:142\.login\] A user can sign in/);
    assert.match(await call('okproof_add_criterion', { issue: '142', text: '{#export} Export works' }), /Added criterion 142\.export /);
    assert.match(await call('okproof_add_criterion', { issue: '142', text: 'Another' }), /Added criterion 142\.5 /);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
