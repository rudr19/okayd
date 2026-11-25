// Research finding B-01: replay is origin-locked and credentials go to the app origin only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAuth } from '../src/verify/auth.js';
import { freshReplay, replayOnly } from '../src/verify/run.js';
import { skip } from './verify-fixture.js';
import type { ReproFile } from '../src/verify/types.js';

interface Srv {
  url: string;
  seen: { url: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function serve(handler: (url: string, send: (status: number, body: string, headers?: Record<string, string>) => void) => void): Promise<Srv> {
  const seen: Srv['seen'] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    handler(req.url ?? '', (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html', 'access-control-allow-origin': '*', ...headers });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const TOKEN = 'Bearer super-secret-token';

test('B-01: a header is sent to the app origin and never to a second server (subresources, fetches and redirects)', { skip, timeout: 90000 }, async () => {
  const other = await serve((_url, send) => send(200, '<!doctype html><title>other</title><p>other</p>'));
  const app = await serve((url, send) => {
    if (url === '/redir') return send(302, '', { location: `${other.url}/landed` });
    send(200, `<!doctype html><title>app</title><h1>app</h1>
<img src="${other.url}/pixel.png">
<script src="${other.url}/x.js"></script>
<script>fetch(${JSON.stringify(other.url + '/api')}).catch(function(){}); fetch('/same').catch(function(){});</script>`);
  });
  try {
    const auth = await prepareAuth({ headers: { Authorization: TOKEN, 'X-Okproof': 'yes' } });
    // 1. subresources and fetches from an app page to the other server
    await freshReplay([{ type: 'goto', url: '/' }], { baseUrl: app.url, auth });
    assert.ok(app.seen.some((r) => r.url === '/' && r.headers.authorization === TOKEN), 'the app origin gets the header');
    assert.ok(app.seen.some((r) => r.url === '/same' && r.headers['x-okproof'] === 'yes'), 'same-origin fetches get it too');
    assert.ok(other.seen.length >= 1, 'the page did reach the other server');
    for (const r of other.seen) {
      assert.equal(r.headers.authorization, undefined, `${r.url} must not receive Authorization`);
      assert.equal(r.headers['x-okproof'], undefined, `${r.url} must not receive X-Okproof`);
    }
    // 2. a redirect from the app to the other server
    other.seen.length = 0;
    await freshReplay([{ type: 'goto', url: '/redir' }], { baseUrl: app.url, auth });
    assert.ok(other.seen.some((r) => r.url === '/landed'));
    for (const r of other.seen) assert.equal(r.headers.authorization, undefined, 'a redirect does not carry the header');
  } finally {
    await app.close();
    await other.close();
  }
});

test('B-01: a replayed goto to another origin is refused before any request is made', { skip, timeout: 60000 }, async () => {
  const other = await serve((_u, send) => send(200, 'x'));
  const app = await serve((_u, send) => send(200, '<!doctype html><h1>app</h1>'));
  try {
    const auth = await prepareAuth({ headers: { Authorization: TOKEN } });
    const { result } = await freshReplay(
      [{ type: 'goto', url: '/' }, { type: 'goto', url: `${other.url}/steal` }, { type: 'assertText', text: 'x', present: true }],
      { baseUrl: app.url, auth },
    );
    assert.equal(result.abortedAt, 1);
    assert.equal(result.refusedOrigin, true);
    assert.match(result.abortReason ?? '', /leaves the app origin/);
    assert.equal(result.assertionFailed.has(2), false);
    assert.equal(other.seen.length, 0, 'the other server never saw a request');
  } finally {
    await app.close();
    await other.close();
  }
});

async function reproDir(baseUrl: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okp-origin-'));
  const dir = join(root, '.okproof');
  await mkdir(join(dir, 'repro'), { recursive: true });
  const repro: ReproFile = { version: 1, criterionId: '1.1', baseUrl, actions: [{ type: 'goto', url: '/' }], violations: [], detectors: [] };
  await writeFile(join(dir, 'repro', '1.1.json'), JSON.stringify(repro));
  return dir;
}

test('B-01: replay-only with credentials needs --url, and refuses a repro recorded against another origin', async () => {
  const dir = await reproDir('https://attacker.example');
  try {
    for (const auth of [{ headers: { Authorization: TOKEN } }, { cookies: [{ name: 'a', value: 'b' }] }]) {
      await assert.rejects(replayOnly({ dir, ...auth }), /needs --url/);
      await assert.rejects(replayOnly({ dir, baseUrl: 'http://127.0.0.1:9', ...auth }), /Refusing to replay it with credentials/);
    }
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('B-01: the refusal never repeats the credential', async () => {
  const dir = await reproDir('https://attacker.example');
  try {
    await assert.rejects(replayOnly({ dir, baseUrl: 'http://127.0.0.1:9', headers: { Authorization: TOKEN } }), (e: Error) => !e.message.includes('super-secret'));
  } finally {
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});

test('B-01: replay-only with a repro that goes off-origin reports REFUSED and fails', { skip, timeout: 90000 }, async () => {
  const other = await serve((_u, send) => send(200, 'x'));
  const app = await serve((_u, send) => send(200, '<!doctype html><h1>app</h1>'));
  const dir = await reproDir(app.url);
  try {
    const repro: ReproFile = { version: 1, criterionId: '1.2', baseUrl: app.url, actions: [{ type: 'goto', url: `${other.url}/x` }], violations: [{ title: 't', expected: 'e', actual: 'a', assertIndex: 1 }], detectors: [] };
    await writeFile(join(dir, 'repro', '1.2.json'), JSON.stringify(repro));
    const results = await replayOnly({ dir, baseUrl: app.url, headers: { Authorization: TOKEN } });
    const bad = results.find((r) => r.criterionId === '1.2')!;
    assert.equal(bad.refused, true);
    assert.equal(other.seen.length, 0);
  } finally {
    await app.close();
    await other.close();
    await rm(join(dir, '..'), { recursive: true, force: true });
  }
});
