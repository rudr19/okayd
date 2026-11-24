// Audit gap 3: `okayd check --issue-body <file>` compares the proof file's
// criteria with the checkboxes in an issue body. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProof, compareToIssueBody } from '../src/proof.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PROOF = '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works\n';

async function run(body: string, extra: string[] = [], proofs: Record<string, string> = { '7.md': PROOF }) {
  const root = await mkdtemp(join(tmpdir(), 'okayd-drift-'));
  try {
    const dir = join(root, '.okayd');
    await mkdir(dir);
    for (const [name, text] of Object.entries(proofs)) await writeFile(join(dir, name), text);
    const file = join(root, 'issue.md');
    await writeFile(file, body);
    const r = spawnSync(process.execPath, [cli, 'check', dir, '--issue-body', file, ...extra], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('matching checkboxes pass, ticked or not, in any order, with other text around them', async () => {
  const r = await run('Intro text\n\n- [x] Second thing works\n* [ ] First thing works\n\nFooter');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /matches the issue body/);
});

test('a criterion added to the issue but not the proof file fails', async () => {
  const r = await run('- [ ] First thing works\n- [ ] Second thing works\n- [ ] Third thing works');
  assert.equal(r.status, 1);
  assert.match(r.out, /missing from the proof file: Third thing works/);
});

test('a criterion removed from the issue but still in the proof file fails', async () => {
  const r = await run('- [ ] First thing works');
  assert.equal(r.status, 1);
  assert.match(r.out, /missing from the issue: Second thing works/);
});

test('an edited criterion shows as one removed and one added', async () => {
  const r = await run('- [ ] First thing works\n- [ ] Second thing works for admins only');
  assert.equal(r.status, 1);
  assert.match(r.out, /Second thing works for admins only/);
  assert.match(r.out, /missing from the issue: Second thing works/);
});

test('an issue body with no checkboxes fails', async () => {
  const r = await run('Just prose.');
  assert.equal(r.status, 1);
});

test('several proof files need --issue to pick one', async () => {
  const proofs = { '7.md': PROOF, '8.md': '## #8 Other\n- [ ] Other thing\n' };
  assert.equal((await run('- [ ] Other thing', [], proofs)).status, 2);
  assert.equal((await run('- [ ] Other thing', ['--issue', '8'], proofs)).status, 0);
  assert.equal((await run('- [ ] Other thing', ['--issue', '9'], proofs)).status, 2);
});

test('compareToIssueBody collapses whitespace', () => {
  const d = compareToIssueBody(parseProof(PROOF), '-   [ ]   First   thing works\n- [ ] Second thing works');
  assert.deepEqual(d, { onlyInIssue: [], onlyInProof: [] });
});
