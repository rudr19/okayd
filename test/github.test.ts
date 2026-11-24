import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLedger, parseProof, publishToGitHub, pullRequestNumber, COMMENT_MARKER } from '../src/index.js';

const ledger = buildLedger(parseProof('## #7 Login\n- [ ] Signs in\n- [ ] Shows errors\n'), [
  { title: 'sign in [okproof:7.1]', status: 'passed' },
]);

interface Call { url: string; method: string; body?: string }

function fakeFetch(existing: Array<{ id: number; body: string }>, calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const json = init?.method ? {} : existing;
    return new Response(JSON.stringify(json), { status: 200 });
  }) as unknown as typeof fetch;
}

async function tmp() {
  return mkdtemp(join(tmpdir(), 'okproof-'));
}

test('does nothing outside GitHub Actions', async () => {
  const calls: Call[] = [];
  const r = await publishToGitHub([ledger], {}, fakeFetch([], calls));
  assert.equal(r.comment, 'skipped');
  assert.equal(calls.length, 0);
});

test('reads the PR number from the event, then the ref', async () => {
  const dir = await tmp();
  const event = join(dir, 'event.json');
  await writeFile(event, JSON.stringify({ pull_request: { number: 42 } }));
  assert.equal(await pullRequestNumber({ GITHUB_EVENT_PATH: event }), 42);
  assert.equal(await pullRequestNumber({ GITHUB_REF: 'refs/pull/9/merge' }), 9);
  assert.equal(await pullRequestNumber({ GITHUB_REF: 'refs/heads/main' }), undefined);
});

test('writes the job summary and creates a comment', async () => {
  const dir = await tmp();
  const summary = join(dir, 'summary.md');
  const calls: Call[] = [];
  const r = await publishToGitHub(
    [ledger],
    { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' },
    fakeFetch([], calls),
  );
  assert.deepEqual(r, { summary: true, comment: 'created' });
  assert.match(await readFile(summary, 'utf8'), /Not proven: 1 of 2 criteria met/);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post?.url, 'https://api.github.com/repos/a/b/issues/5/comments');
  assert.ok(JSON.parse(post!.body!).body.startsWith(COMMENT_MARKER));
});

test('updates its own comment on a rerun', async () => {
  const calls: Call[] = [];
  const r = await publishToGitHub(
    [ledger],
    { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' },
    fakeFetch([{ id: 1, body: 'someone else' }, { id: 99, body: `${COMMENT_MARKER}\nold` }], calls),
  );
  assert.equal(r.comment, 'updated');
  assert.equal(calls.find((c) => c.method === 'PATCH')?.url, 'https://api.github.com/repos/a/b/issues/comments/99');
});

test('a read-only token skips the comment instead of failing', async () => {
  const forbidden = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
  const r = await publishToGitHub(
    [ledger],
    { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', GITHUB_REF: 'refs/pull/5/merge' },
    forbidden,
  );
  assert.equal(r.comment, 'skipped');
  assert.match(r.reason ?? '', /403/);
});

test('rejects a malformed repository, non-https API URL, and caps huge comments', async () => {
  const { apiBase, capBody, MAX_COMMENT_CHARS } = await import('../src/github.js');
  const calls: Call[] = [];
  const base = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't', GITHUB_REF: 'refs/pull/5/merge' };
  for (const env of [
    { ...base, GITHUB_REPOSITORY: 'evil.com/../x' },
    { ...base, GITHUB_REPOSITORY: 'a/b', GITHUB_API_URL: 'http://api.github.com' },
    { ...base, GITHUB_REPOSITORY: 'a/b', GITHUB_API_URL: 'https://u:p@api.github.com' },
  ]) {
    const r = await publishToGitHub([ledger], env, fakeFetch([], calls));
    assert.equal(r.comment, 'skipped');
  }
  assert.equal(calls.length, 0, 'no request is sent for invalid input');
  assert.equal(apiBase(undefined), 'https://api.github.com');
  assert.equal(apiBase('https://github.example.com/api/v3/'), 'https://github.example.com/api/v3');
  const capped = capBody('x'.repeat(MAX_COMMENT_CHARS + 10));
  assert.ok(capped.length < MAX_COMMENT_CHARS + 200 && capped.includes('truncated'));
});
