// Research finding B-10: only adopt a marked comment written by the token's own identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, parseProof, publishToGitHub, COMMENT_MARKER } from '../src/index.js';

const ledger = buildLedger(parseProof('## #7 Login\n- [ ] Signs in\n'), [{ title: 'sign in [okproof:7.1]', status: 'passed', assertions: 1 }]);
const ENV = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' };

interface C { id: number; body: string; user?: { login: string } }

function api(comments: C[], userLogin: string | undefined, calls: { url: string; method: string }[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.endsWith('/user')) return userLogin ? new Response(JSON.stringify({ login: userLogin }), { status: 200 }) : new Response('{}', { status: 403 });
    if (method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
}

test('B-10: a marker comment posted by someone else is not ours; okproof creates its own (GITHUB_TOKEN)', async () => {
  const calls: { url: string; method: string }[] = [];
  const squatter: C = { id: 1, body: `${COMMENT_MARKER}\nfake`, user: { login: 'mallory' } };
  const r = await publishToGitHub([ledger], ENV, api([squatter], undefined, calls));
  assert.equal(r.comment, 'created');
  assert.equal(calls.some((c) => c.method === 'PATCH'), false);
});

test('B-10: with GITHUB_TOKEN the github-actions[bot] marker comment is updated, even after a squatter', async () => {
  const calls: { url: string; method: string }[] = [];
  const comments: C[] = [
    { id: 1, body: `${COMMENT_MARKER}\nfake`, user: { login: 'mallory' } },
    { id: 2, body: `${COMMENT_MARKER}\nreal`, user: { login: 'github-actions[bot]' } },
  ];
  const r = await publishToGitHub([ledger], ENV, api(comments, undefined, calls));
  assert.equal(r.comment, 'updated');
  assert.equal(calls.find((c) => c.method === 'PATCH')?.url, 'https://api.github.com/repos/a/b/issues/comments/2');
});

test('B-10: with a personal token (GET /user answers) only that user\'s marker comment is adopted', async () => {
  const comments: C[] = [
    { id: 1, body: `${COMMENT_MARKER}\nfake`, user: { login: 'mallory' } },
    { id: 2, body: `${COMMENT_MARKER}\nmine`, user: { login: 'Rudr19' } },
  ];
  const calls: { url: string; method: string }[] = [];
  const r = await publishToGitHub([ledger], ENV, api(comments, 'rudr19', calls));
  assert.equal(r.comment, 'updated');
  assert.equal(calls.find((c) => c.method === 'PATCH')?.url, 'https://api.github.com/repos/a/b/issues/comments/2');
});

test('B-10: a marker comment with no author information is never adopted', async () => {
  const calls: { url: string; method: string }[] = [];
  const r = await publishToGitHub([ledger], ENV, api([{ id: 3, body: `${COMMENT_MARKER}\nx` }], undefined, calls));
  assert.equal(r.comment, 'created');
});

test('B-10: OKPROOF_COMMENT_AUTHOR names the bot for an app token', async () => {
  const calls: { url: string; method: string }[] = [];
  const r = await publishToGitHub([ledger], { ...ENV, OKPROOF_COMMENT_AUTHOR: 'my-app[bot]' }, api([{ id: 4, body: `${COMMENT_MARKER}\nx`, user: { login: 'my-app[bot]' } }], undefined, calls));
  assert.equal(r.comment, 'updated');
});
