import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/driver/index.js';
import {
  Detectors,
  brokenLinkFindings,
  overflowFinding,
  problemFindings,
  snapshotFindings,
} from '../src/verify/detectors.js';
import { parseSnapshotRefs } from '../src/verify/actions.js';
import { skip } from './verify-fixture.js';

const ctx = { url: 'http://x.test/', step: 3 };

test('problemFindings classifies and skips noise', () => {
  const found = problemFindings(
    {
      console: ['warning: ignore me', 'error: boom', 'exception: TypeError: x is undefined\n at foo', 'log error: Failed to load resource: 404'],
      network: ['404 http://x.test/api', '503 http://x.test/other', 'http://x.test/dead net::ERR_FAILED', '404 http://x.test/favicon.ico'],
    },
    { console: 0, network: 0 },
    ctx,
  );
  assert.deepEqual(
    found.map((f) => [f.kind, f.severity]),
    [['console-error', 3], ['page-exception', 4], ['http-error', 3], ['http-error', 4], ['request-failed', 3]],
  );
  assert.match(found[1]!.title, /TypeError: x is undefined/);
});

test('problemFindings only reports what is past the cursor and ignores network while offline', () => {
  const problems = { console: ['error: old', 'error: new'], network: ['500 http://x.test/a'] };
  assert.deepEqual(problemFindings(problems, { console: 1, network: 1 }, ctx).map((f) => f.title), ['Console error: new']);
  assert.deepEqual(problemFindings(problems, { console: 2, network: 0 }, { ...ctx, offline: true }), []);
});

test('snapshotFindings flags interactive elements with no name', () => {
  const text = [
    '- heading "Hi" [level=1]',
    '- button [ref=e1]',
    '- button [ref=e2]',
    '- button "Save" [ref=e3]',
    '- textbox [ref=e4] [required]',
  ].join('\n');
  const found = snapshotFindings(text, ctx);
  assert.deepEqual(found.map((f) => f.title), ['Unnamed button', 'Unnamed textbox']);
  assert.match(found[0]!.detail, /2 button elements have no accessible name/);
});

test('parseSnapshotRefs numbers duplicates and decodes names', () => {
  const refs = parseSnapshotRefs('- button "Save" [ref=e1]\n- link "A \\"q\\"" [ref=e2]\n  - button "Save" [ref=e3] [disabled]\n- button [ref=e4]');
  assert.deepEqual(refs.map((r) => [r.ref, r.role, r.name, r.nth]), [
    ['e1', 'button', 'Save', 0],
    ['e2', 'link', 'A "q"', 0],
    ['e3', 'button', 'Save', 1],
    ['e4', 'button', '', 0],
  ]);
});

test('overflowFinding allows a 1px rounding error', () => {
  assert.equal(overflowFinding({ scrollWidth: 801, innerWidth: 800 }, ctx), undefined);
  const f = overflowFinding({ scrollWidth: 2000, innerWidth: 375 }, ctx);
  assert.equal(f?.kind, 'horizontal-overflow');
  assert.match(f!.title, /375px/);
});

test('brokenLinkFindings checks same-origin links only, falls back to GET, and caps', async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string, init: { method: string }): Promise<{ status: number }> => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith('/gone')) return { status: 404 };
    if (url.endsWith('/head-405')) return { status: init.method === 'HEAD' ? 405 : 200 };
    return { status: 200 };
  };
  const links = ['http://x.test/gone', 'http://x.test/head-405', 'http://x.test/ok#frag', 'http://other.test/never', 'http://x.test/'];
  const found = await brokenLinkFindings(links, 'http://x.test', ctx, { fetch: fakeFetch });
  assert.deepEqual(found.map((f) => f.title), ['Broken link: /gone']);
  assert.ok(calls.includes('GET http://x.test/head-405'));
  assert.ok(!calls.some((c) => c.includes('other.test')));
  assert.ok(!calls.some((c) => c.endsWith('x.test/')), 'the current page is not rechecked');

  const many = Array.from({ length: 50 }, (_, i) => `http://x.test/p${i}`);
  calls.length = 0;
  await brokenLinkFindings(many, 'http://x.test', ctx, { fetch: fakeFetch });
  assert.equal(calls.length, 20);
});

const page = `<!doctype html><title>Buggy</title><body style="margin:0">
<h1>Buggy page</h1>
<button></button>
<div style="width:2000px;height:10px;background:red"></div>
<script>console.error('detector boom');</script></body>`;

test('live detectors find console error, unnamed control and overflow, then dedupe', { skip, timeout: 60000 }, async () => {
  const browser = await Browser.launch();
  try {
    const p = await browser.newPage();
    await p.goto('data:text/html;charset=utf-8,' + encodeURIComponent(page));
    const detectors = new Detectors(p, { baseUrl: 'http://127.0.0.1:1' });
    const found = await detectors.run(0);
    const kinds = found.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['console-error', 'horizontal-overflow', 'unnamed-control'], JSON.stringify(found));
    assert.match(found.find((f) => f.kind === 'console-error')!.title, /detector boom/);
    assert.deepEqual(await detectors.run(1), [], 'a second run adds nothing');
  } finally {
    await browser.close();
  }
});
