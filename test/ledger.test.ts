import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProof, claimedCriteria, buildLedger, renderLedgerMarkdown } from '../src/index.js';

const SOURCE = `## #142 Pro upgrade
- [ ] A member can upgrade the workspace to Pro from Billing
- [ ] Invoice preview shows a prorated amount
- [ ] A viewer cannot see the upgrade button
`;

test('parses criteria with stable ids', () => {
  const proof = parseProof(SOURCE);
  assert.equal(proof.issue, '142');
  assert.equal(proof.title, 'Pro upgrade');
  assert.deepEqual(proof.criteria.map((c) => c.id), ['142.1', '142.2', '142.3']);
});

test('rejects a proof file without a heading or criteria', () => {
  assert.throws(() => parseProof('- [ ] orphan'), /heading/);
  assert.throws(() => parseProof('## #9 Empty'), /no "- \[ \]" criteria/);
});

test('reads claimed criteria from test titles', () => {
  assert.deepEqual(claimedCriteria('upgrade [okproof:142.1] [okproof:142.2]'), ['142.1', '142.2']);
  assert.deepEqual(claimedCriteria('no tag here'), []);
});

test('untested and flaky never count as proven', () => {
  const ledger = buildLedger(parseProof(SOURCE), [
    { title: 'upgrade [okproof:142.1]', status: 'passed', evidence: 'traces/1.zip' },
    { title: 'preview [okproof:142.2]', status: 'flaky' },
  ]);
  assert.deepEqual(ledger.entries.map((e) => e.verdict), ['met', 'failed', 'untested']);
  assert.equal(ledger.proven, false);
  assert.match(renderLedgerMarkdown(ledger), /Not proven: 1 of 3 criteria met/);
});

test('every criterion passing proves the issue', () => {
  const ledger = buildLedger(parseProof(SOURCE), [
    { title: 'a [okproof:142.1]', status: 'passed' },
    { title: 'b [okproof:142.2] [okproof:142.3]', status: 'passed' },
  ]);
  assert.equal(ledger.proven, true);
});
