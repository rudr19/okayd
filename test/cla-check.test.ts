// B-17: one CLA sentence everywhere, and a read-only check that enforces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cla = await import(pathToFileURL(join(root, 'scripts', 'cla-check.mjs')).href);
const PHRASE: string = cla.CLA_PHRASE;

test('the CLA sentence is identical in CLA.md, CONTRIBUTING.md and the check', async () => {
  for (const f of ['CLA.md', 'CONTRIBUTING.md']) {
    const text = await readFile(join(root, f), 'utf8');
    assert.ok(text.includes(PHRASE), `${f} must contain the exact sentence`);
    assert.ok(!text.includes('I agree to the okproof CLA'), `${f} still has the old sentence`);
  }
  assert.equal(PHRASE, 'I have read the okproof CLA and I agree to it.');
  const clamd = await readFile(join(root, 'CLA.md'), 'utf8');
  assert.match(clamd, /Draft only\. Have a lawyer review it/, 'the lawyer-review note stays until it has happened');
});

test('isSignature is exact (trimmed) equality, nothing looser', () => {
  assert.equal(cla.isSignature(PHRASE), true);
  assert.equal(cla.isSignature(`  ${PHRASE}\n`), true);
  assert.equal(cla.isSignature(PHRASE.toLowerCase()), false);
  assert.equal(cla.isSignature(`${PHRASE} Thanks!`), false);
  assert.equal(cla.isSignature(`> ${PHRASE}`), false);
  assert.equal(cla.isSignature(undefined), false);
});

const sign = (login: string, body = PHRASE) => ({ user: { login }, body });

test('a first-time contributor must have signed on this PR, as themselves', () => {
  const base = { author: 'newbie', association: 'FIRST_TIME_CONTRIBUTOR', comments: [] as ReturnType<typeof sign>[] };
  assert.equal(cla.checkCla(base).ok, false);
  assert.match(cla.checkCla(base).reason, /Comment exactly: I have read the okproof CLA/);
  assert.equal(cla.checkCla({ ...base, comments: [sign('newbie')] }).ok, true);
  // someone else posting the sentence does not sign for the author
  assert.equal(cla.checkCla({ ...base, comments: [sign('someone-else')] }).ok, false);
  assert.equal(cla.checkCla({ ...base, comments: [sign('newbie', 'I agree')] }).ok, false);
  for (const association of ['NONE', 'FIRST_TIMER']) assert.equal(cla.checkCla({ ...base, association }).ok, false);
});

test('owners, members, collaborators, returning contributors and bots are not asked', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']) {
    assert.equal(cla.checkCla({ author: 'x', association, comments: [] }).ok, true, association);
  }
  assert.equal(cla.checkCla({ author: 'dependabot[bot]', association: 'NONE', authorType: 'Bot', comments: [] }).ok, true);
  assert.equal(cla.checkCla({ author: 'some-app[bot]', association: 'NONE', comments: [] }).ok, true);
});

test('the workflow is read-only and uses pull_request, never pull_request_target', async () => {
  const yml = await readFile(join(root, '.github', 'workflows', 'cla-check.yml'), 'utf8');
  const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /pull_request_target/);
  assert.match(code, /\n {2}pull_request:/);
  assert.match(code, /pull-requests: read/);
  assert.doesNotMatch(code, /(write|admin)\b/);
  assert.match(code, /persist-credentials: false/);
  // no workflow in this repository may use pull_request_target
  for (const f of ['ci.yml', 'codeql.yml', 'dco.yml', 'dependency-review.yml', 'release.yml', 'scorecard.yml', 'self-test.yml']) {
    const text = (await readFile(join(root, '.github', 'workflows', f), 'utf8')).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(text, /pull_request_target/, f);
  }
});
