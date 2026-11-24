import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proofFromIssue, syncProofFile, fetchIssue, linkedIssues, issueCriteria } from '../src/sync.js';
import { parseProof } from '../src/proof.js';

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'okproof-sync-'));

test('proofFromIssue renders one unchecked line per checkbox variant', () => {
  const out = proofFromIssue({
    issue: 7,
    title: '  Pro   upgrade ',
    body: 'Intro\n- [ ] one\n- [x] two\n* [ ] three\n  - [X]   four  spaced\n- not a checkbox\n- [] nope\n',
  });
  assert.equal(out, '## #7 Pro upgrade\n- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four spaced\n');
  const proof = parseProof(out);
  assert.equal(proof.criteria[3]!.id, '7.4');
});

test('proofFromIssue ignores checkboxes in fenced code blocks', () => {
  const body = ['- [ ] real', '```md', '- [ ] in backticks', '```', '~~~', '- [ ] in tildes', '~~~', '````', '```', '- [ ] still fenced', '````', '- [ ] also real'].join('\n');
  assert.deepEqual(issueCriteria(body), ['real', 'also real']);
});

test('an Acceptance criteria heading scopes the criteria to its section', () => {
  const body = [
    '- [ ] before',
    '## Acceptance criteria',
    '- [ ] a',
    '### Sub heading stays inside',
    '- [ ] b',
    '## Notes',
    '- [ ] after',
  ].join('\n');
  assert.deepEqual(issueCriteria(body), ['a', 'b']);
  assert.deepEqual(issueCriteria('## Acceptance Criteria:\n- [ ] x\n'), ['x']);
  // Without such a heading every checkbox counts.
  assert.deepEqual(issueCriteria('## Tasks\n- [ ] p\n- [ ] q'), ['p', 'q']);
});

test('proofFromIssue rejects bad issue numbers and bodies with no criteria', () => {
  for (const issue of [0, -1, 1.5, NaN]) assert.throws(() => proofFromIssue({ issue, title: 't', body: '- [ ] a' }), /positive integer/);
  assert.throws(() => proofFromIssue({ issue: 1, title: 't', body: 'no boxes' }), /no "- \[ \]" checkboxes/);
});

test('syncProofFile creates the file when missing', async () => {
  const cwd = await tmp();
  const r = await syncProofFile({ cwd, dir: '.okproof', issue: 3, title: 'T', body: '- [ ] a\n- [ ] b' });
  assert.equal(r.created, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added.map((c) => c.id), ['3.1', '3.2']);
  assert.equal(await readFile(join(cwd, '.okproof', '3.md'), 'utf8'), '## #3 T\n- [ ] a\n- [ ] b\n');
});

test('syncProofFile keeps order and ids, appends new, drops removed, and is a no-op when in sync', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, 'p'));
  await writeFile(join(cwd, 'p', '5.md'), '## #5 T\n- [ ] a\n- [ ] b\n- [ ] c\n');
  // Issue reordered and gained "d"; nothing removed.
  const r = await syncProofFile({ cwd, dir: 'p', issue: 5, title: 'T', body: '- [ ] c\n- [ ] d\n- [ ] a\n- [ ] b' });
  assert.deepEqual(r.added, [{ id: '5.4', text: 'd' }]);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.unchanged.map((c) => c.text), ['a', 'b', 'c']);
  assert.deepEqual(r.renumbered, []);
  assert.equal(await readFile(join(cwd, 'p', '5.md'), 'utf8'), '## #5 T\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n');
  const again = await syncProofFile({ cwd, dir: 'p', issue: 5, title: 'T', body: '- [x] a\n- [ ] b\n- [ ] c\n- [ ] d' });
  assert.equal(again.changed, false);
});

test('removing a middle criterion reports the renumbered ids', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, 'p'));
  await writeFile(join(cwd, 'p', '9.md'), '## #9 T\n- [ ] a\n- [ ] b\n- [ ] c\n');
  const r = await syncProofFile({ cwd, dir: 'p', issue: 9, title: 'T', body: '- [ ] a\n- [ ] c\n- [ ] new' });
  assert.deepEqual(r.removed, [{ id: '9.2', text: 'b' }]);
  assert.deepEqual(r.renumbered, [{ text: 'c', from: '9.3', to: '9.2' }]);
  assert.deepEqual(r.added, [{ id: '9.3', text: 'new' }]);
});

test('write:false reports drift without touching the file', async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, 'p'));
  await writeFile(join(cwd, 'p', '2.md'), '## #2 T\n- [ ] a\n');
  const r = await syncProofFile({ cwd, dir: 'p', issue: 2, title: 'T', body: '- [ ] a\n- [ ] b', write: false });
  assert.equal(r.changed, true);
  assert.equal(await readFile(join(cwd, 'p', '2.md'), 'utf8'), '## #2 T\n- [ ] a\n');
});

test('syncProofFile refuses a dir outside cwd, a bad issue, and a file for another issue', async () => {
  const cwd = await tmp();
  const base = { cwd, title: 'T', body: '- [ ] a' };
  await assert.rejects(syncProofFile({ ...base, dir: '..', issue: 1 }), /inside the current directory/);
  await assert.rejects(syncProofFile({ ...base, dir: '../../etc', issue: 1 }), /inside the current directory/);
  await assert.rejects(syncProofFile({ ...base, dir: join(tmpdir(), 'elsewhere'), issue: 1 }), /inside the current directory/);
  await assert.rejects(syncProofFile({ ...base, dir: 'p', issue: 0 }), /positive integer/);
  await mkdir(join(cwd, 'p'));
  await writeFile(join(cwd, 'p', '4.md'), '## #8 Other\n- [ ] a\n');
  await assert.rejects(syncProofFile({ ...base, dir: 'p', issue: 4 }), /describes issue #8/);
});

test('linkedIssues finds closing keywords and ignores code, comments, and other repos', () => {
  const body = [
    'Closes #12 and fixes: #3.',
    'RESOLVED #7',
    'closes #12',
    'Closes other/repo#5',
    'prefixes #8 and unfixes #9',
    '<!-- Closes #40 -->',
    '```',
    'Fixes #41',
    '```',
    'See #10',
  ].join('\n');
  assert.deepEqual(linkedIssues(body), [12, 3, 7]);
  assert.deepEqual(linkedIssues(''), []);
  assert.deepEqual(linkedIssues('Fixes #0'), []);
});

function fakeFetch(status: number, json: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('fetchIssue reads title and body', async () => {
  const calls: string[] = [];
  const got = await fetchIssue({ repo: 'o/r', issue: 4, token: 't', fetchImpl: fakeFetch(200, { title: 'Hi', body: null }, calls) });
  assert.deepEqual(got, { title: 'Hi', body: '' });
  assert.deepEqual(calls, ['https://api.github.com/repos/o/r/issues/4']);
});

test('fetchIssue gives clear errors for 404, 403 and pull requests', async () => {
  await assert.rejects(fetchIssue({ repo: 'o/r', issue: 4, fetchImpl: fakeFetch(404, {}) }), /not found/);
  await assert.rejects(fetchIssue({ repo: 'o/r', issue: 4, fetchImpl: fakeFetch(403, {}) }), /403/);
  await assert.rejects(fetchIssue({ repo: 'o/r', issue: 4, fetchImpl: fakeFetch(200, { title: 't', pull_request: {} }) }), /pull request/);
});

test('fetchIssue rejects invalid input without making a request', async () => {
  const calls: string[] = [];
  const f = fakeFetch(200, { title: 't' }, calls);
  await assert.rejects(fetchIssue({ repo: 'o/r/../x', issue: 1, fetchImpl: f }), /owner\/name/);
  await assert.rejects(fetchIssue({ repo: 'o/r?x=1', issue: 1, fetchImpl: f }), /owner\/name/);
  await assert.rejects(fetchIssue({ repo: 'o/r', issue: -2, fetchImpl: f }), /positive integer/);
  await assert.rejects(fetchIssue({ repo: 'o/r', issue: 1, apiUrl: 'http://evil.test', fetchImpl: f }), /https/);
  assert.deepEqual(calls, []);
});
