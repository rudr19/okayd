// E-8: proof files record where they came from; sync --check says whether the issue or the file moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driftCause, formatMarker, issueDigest, parseMarker, proofDigest, withoutMarker } from '../src/provenance.js';
import { syncProofFile, describeSync, fetchIssue } from '../src/sync.js';
import { parseProof } from '../src/proof.js';
import { buildLedger } from '../src/ledger.js';
import { staleness } from '../src/gate.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'okproof-prov-'));
const H64 = 'a'.repeat(64);

test('marker: format and parse round-trip; junk is ignored', () => {
  const line = formatMarker({ updatedAt: '2026-11-20T10:00:00Z', issueSha256: H64, proofSha256: 'b'.repeat(64) });
  assert.equal(line, `<!-- okproof:issue updated_at=2026-11-20T10:00:00Z sha256=${H64} proof_sha256=${'b'.repeat(64)} -->`);
  assert.deepEqual(parseMarker(`## #1 T\n${line}\n- [ ] a\n`), { updatedAt: '2026-11-20T10:00:00Z', issueSha256: H64, proofSha256: 'b'.repeat(64) });
  assert.equal(parseMarker('## #1 T\n- [ ] a\n'), undefined);
  assert.equal(parseMarker('## #1 T\n<!-- okproof:issue sha256=zzz -->\n- [ ] a\n'), undefined, 'a malformed digest is not a record');
  assert.equal(parseMarker(`## #1 T\n<!-- okproof:issue sha256=${H64}\n- [ ] a\n`), undefined, 'unterminated');
  // an updated_at that is not a timestamp is never written into a file
  assert.ok(!formatMarker({ updatedAt: 'x --> <script>', issueSha256: H64 }).includes('updated_at'));
});

test('withoutMarker and proofDigest ignore the record line and CRLF', () => {
  const body = '## #1 T\n- [ ] a\n';
  const withLine = `## #1 T\n${formatMarker({ issueSha256: H64 })}\n- [ ] a\n`;
  assert.equal(withoutMarker(withLine), body);
  assert.equal(proofDigest(withLine), proofDigest(body));
  assert.equal(proofDigest(body.split('\n').join('\r\n')), proofDigest(body));
  assert.notEqual(proofDigest(body), proofDigest('## #1 T\n- [ ] b\n'));
});

test('marker scanning is linear on hostile input', () => {
  const big = '<!-- okproof:issue '.repeat(60_000);
  const t0 = Date.now();
  parseMarker(big);
  withoutMarker(big);
  proofDigest(big);
  assert.ok(Date.now() - t0 < 2_000);
});

test('driftCause: three-way comparison', () => {
  const rec = { issueSha256: 'i1', proofSha256: 'p1' };
  assert.equal(driftCause(rec, { issueSha256: 'i2', proofSha256: 'p1' }), 'issue');
  assert.equal(driftCause(rec, { issueSha256: 'i1', proofSha256: 'p2' }), 'local');
  assert.equal(driftCause(rec, { issueSha256: 'i2', proofSha256: 'p2' }), 'both');
  assert.equal(driftCause(rec, { issueSha256: 'i1', proofSha256: 'p1' }), 'neither');
  assert.equal(driftCause(undefined, { issueSha256: 'i1', proofSha256: 'p1' }), 'unrecorded');
});

const opts = (cwd: string, body: string, extra: Record<string, unknown> = {}) => ({ cwd, dir: 'p', issue: 5, title: 'T', body, ...extra });

test('sync records the issue, and updated_at alone never counts as drift', async () => {
  const cwd = await tmp();
  await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { issueUpdatedAt: '2026-11-20T10:00:00Z' }));
  const text = await readFile(join(cwd, 'p', '5.md'), 'utf8');
  const rec = parseMarker(text)!;
  assert.equal(rec.updatedAt, '2026-11-20T10:00:00Z');
  assert.equal(rec.issueSha256, issueDigest('T', ['a', 'b']));
  assert.equal(rec.proofSha256, proofDigest(text));
  assert.equal(parseProof(text).criteria.length, 2, 'the record line does not disturb the proof file');
  // A label or comment bumped updated_at: not drift, and check mode writes nothing.
  const check = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { issueUpdatedAt: '2026-11-21T09:00:00Z', write: false }));
  assert.equal(check.changed, false);
  assert.equal(await readFile(join(cwd, 'p', '5.md'), 'utf8'), text);
  // Write mode refreshes the human-readable stamp only.
  const again = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { issueUpdatedAt: '2026-11-21T09:00:00Z' }));
  assert.equal(again.changed, false);
  assert.equal(again.recordRefreshed, true);
  assert.equal(parseMarker(await readFile(join(cwd, 'p', '5.md'), 'utf8'))!.updatedAt, '2026-11-21T09:00:00Z');
});

test('check: "the issue changed since sync" is told apart from "the proof file was edited locally"', async () => {
  const cwd = await tmp();
  await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b'));
  const path = join(cwd, 'p', '5.md');
  const synced = await readFile(path, 'utf8');

  const issueMoved = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b\n- [ ] c', { write: false }));
  assert.equal(issueMoved.changed, true);
  assert.equal(issueMoved.drift, 'issue');
  assert.match(describeSync(5, issueMoved, false).lines.join('\n'), /why: the issue changed since the proof file was synced/);

  await writeFile(path, synced.replace('- [ ] b', '- [ ] b, but weaker'));
  const edited = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { write: false }));
  assert.equal(edited.changed, true);
  assert.equal(edited.drift, 'local');
  assert.match(describeSync(5, edited, false).lines.join('\n'), /why: the proof file was edited locally since it was synced \(the issue is unchanged\)/);

  const both = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b\n- [ ] c', { write: false }));
  assert.equal(both.drift, 'both');
  assert.equal(await readFile(path, 'utf8'), synced.replace('- [ ] b', '- [ ] b, but weaker'), 'check never writes');
});

test('a proof file with no record behaves as before, says why it cannot tell, and gets one on write', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, 'p'));
  const path = join(cwd, 'p', '5.md');
  await writeFile(path, '## #5 T\n\nA note I wrote.\n\n- [ ] a\n- [ ] b\n');
  const sameCheck = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { write: false }));
  assert.equal(sameCheck.changed, false, 'no record is not drift');
  assert.equal(sameCheck.drift, undefined);
  const drift = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] x', { write: false }));
  assert.equal(drift.drift, 'unrecorded');
  assert.match(describeSync(5, drift, false).lines.join('\n'), /no okproof:issue record/);
  // In step with the issue, write mode only adds the record: the note stays.
  const wrote = await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b'));
  assert.equal(wrote.recordRefreshed, true);
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes('A note I wrote.'));
  assert.equal(text.split('\n')[1]?.startsWith('<!-- okproof:issue'), true, 'record sits under the heading');
  assert.equal(parseMarker(text)!.proofSha256, proofDigest(text));
  assert.equal((await syncProofFile(opts(cwd, '- [ ] a\n- [ ] b', { write: false }))).changed, false);
});

test('the CLI explains the cause on stderr/stdout and exits 1', async () => {
  const cwd = await tmp();
  await writeFile(join(cwd, 'issue.md'), '# T\n- [ ] one\n- [ ] two\n');
  const run = (...a: string[]) => spawnSync(process.execPath, [cli, 'sync', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(run('--issue', '3', '--body-file', 'issue.md').status, 0);
  await writeFile(join(cwd, 'issue.md'), '# T\n- [ ] one\n- [ ] three\n');
  const r = run('--issue', '3', '--body-file', 'issue.md', '--check');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /why: the issue changed since the proof file was synced/);
});

test('fetchIssue returns a well-formed updated_at', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ title: 'T', body: '- [ ] a', updated_at: '2026-11-20T10:00:00Z' }), { status: 200 })) as typeof fetch;
  const got = await fetchIssue({ repo: 'o/r', issue: 1, fetchImpl });
  assert.equal(got.updatedAt, '2026-11-20T10:00:00Z');
});

// The gate already refuses a ledger whose criterion text moved under its id (positional ids included).
test('positional ids: removing an earlier criterion makes the ledger STALE (edited ids are named)', () => {
  const before = parseProof('## #142 T\n- [ ] sign in\n- [ ] sign out\n- [ ] reset password\n');
  const ledger = buildLedger(before, [{ title: 'sign out [okproof:142.2]', status: 'passed', assertions: 1 }]);
  const after = parseProof('## #142 T\n- [ ] sign out\n- [ ] reset password\n');
  const why = staleness(after, ledger)!;
  assert.match(why, /STALE/);
  assert.match(why, /removed 142\.3/);
  assert.match(why, /edited 142\.1, 142\.2/);
  // a stable id does not move
  const stable = parseProof('## #142 T\n- [ ] {#in} sign in\n- [ ] {#out} sign out\n');
  const l2 = buildLedger(stable, []);
  assert.equal(staleness(parseProof('## #142 T\n- [ ] {#out} sign out\n- [ ] {#in} sign in\n'), l2), undefined);
});
