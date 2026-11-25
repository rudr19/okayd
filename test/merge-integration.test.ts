// Differential proof and evidence levels working together: `pre`, and E3 read from the files
// okproof diff and okproof revert-check actually write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProof } from '../src/proof.js';
import { classify } from '../src/differential.js';
import { readAdversarial } from '../src/evidence.js';
import { techniqueFindings } from '../src/techniques.js';
import { buildLedger, type TestOutcome } from '../src/ledger.js';
import { evaluateGate } from '../src/gate.js';
import { criteriaHash } from '../src/verify/ledger.js';

const PASS: TestOutcome = { title: 'works [okproof:7.a]', status: 'passed', assertions: 2 };
const proofText = (line: string) => `## #7 Thing\n\n- [ ] ${line}\n`;

test('classify treats the pre token in the leading block and a bare {pre} the same', () => {
  for (const line of ['{#a pre} Works', '{#a pre E2} Works', '{#a} Works {pre}']) {
    const proof = parseProof(proofText(line));
    const [c] = classify(proof, [PASS], [PASS]);
    assert.equal(c.status, 'not-differential');
    assert.equal(c.allowed, true, line);
  }
  const plain = classify(parseProof(proofText('{#a} Works')), [PASS], [PASS]);
  assert.equal(plain[0].allowed, false);
});

test('the gate accepts a not-differential criterion marked pre in the leading block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-merge-'));
  for (const [line, ok] of [['{#a pre} Works', true], ['{#a} Works', false]] as const) {
    const proof = parseProof(proofText(line));
    await writeFile(join(dir, '7.md'), proofText(line));
    const diff = { version: 1, issue: '7', criteriaHash: criteriaHash(proof), criteria: classify(proof, [PASS], [PASS]) };
    await writeFile(join(dir, 'diff-7.json'), JSON.stringify(diff));
    const ledger = buildLedger(proof, [PASS], {});
    const res = await evaluateGate(dir, { ledgers: [ledger] });
    assert.equal(res.ok, ok, res.problems.join('\n'));
  }
  assert.deepEqual(await techniqueFindings(dir, parseProof(proofText('{#a pre} Works'))), []);
});

test('E3 is read from the diff and revert files exactly as okproof writes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-merge-'));
  const proof = parseProof(proofText('{#a E3} Works'));
  await writeFile(join(dir, '7.md'), proofText('{#a E3} Works'));
  const hash = criteriaHash(proof);
  const none = await readAdversarial(dir, proof);
  assert.equal(none.get('7.a')?.byChange, undefined);

  const diff = (status: string, h = hash) => ({ version: 1, issue: '7', criteriaHash: h, criteria: [{ id: '7.a', status, allowed: false, base: { state: 'fail', tests: [] }, head: { state: 'pass', tests: [] } }] });
  await writeFile(join(dir, 'diff-7.json'), JSON.stringify(diff('proven-by-change')));
  assert.equal((await readAdversarial(dir, proof)).get('7.a')?.byChange, true);
  const ledger = buildLedger(proof, [PASS], { adversarial: await readAdversarial(dir, proof) });
  assert.equal(ledger.entries[0].level, 3);
  assert.equal((await evaluateGate(dir, { ledgers: [ledger] })).ok, true);

  // Statuses that are not proof by change give nothing; a stale hash gives nothing.
  await writeFile(join(dir, 'diff-7.json'), JSON.stringify(diff('not-differential')));
  assert.equal((await readAdversarial(dir, proof)).get('7.a')?.byChange, undefined);
  await writeFile(join(dir, 'diff-7.json'), JSON.stringify(diff('proven-by-change', 'stale')));
  assert.equal((await readAdversarial(dir, proof)).get('7.a')?.byChange, undefined);

  await writeFile(join(dir, 'diff-7.json'), '{}');
  const revert = { version: 1, issue: '7', criteriaHash: hash, criteria: [{ id: '7.a', status: 'covered', allowed: false, coveredBy: ['src/x.ts'] }] };
  await writeFile(join(dir, 'revert-7.json'), JSON.stringify(revert));
  assert.equal((await readAdversarial(dir, proof)).get('7.a')?.byChange, true);
  revert.criteria[0].status = 'uncovered';
  await writeFile(join(dir, 'revert-7.json'), JSON.stringify(revert));
  assert.equal((await readAdversarial(dir, proof)).get('7.a')?.byChange, undefined);
});

test('a criterion needing E3 fails the gate without by-change or verifier evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-merge-'));
  const proof = parseProof(proofText('{#a E3} Works'));
  await writeFile(join(dir, '7.md'), proofText('{#a E3} Works'));
  const res = await evaluateGate(dir, { ledgers: [buildLedger(proof, [PASS], {})] });
  assert.equal(res.ok, false);
  assert.match(res.problems.join('\n'), /requires E3/);
});
