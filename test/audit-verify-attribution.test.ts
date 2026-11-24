// Audit gap 6: detectors are page-global. A third-party failure, or something
// that was already broken when the page loaded, must not refute a criterion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedModel, type ScriptedStep } from '../src/verify/model.js';
import { verify, type VerifyOptions } from '../src/verify/run.js';
import { refOf, skip } from './verify-fixture.js';

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const stop = (s: Server): Promise<void> => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });

type Kind = 'same-click' | 'third-click' | 'same-load' | 'third-load';

/**
 * App with a "Go" button. Clicking it loads a missing image, from the app's own
 * origin ("same") or from another origin ("third"). The "-load" kinds load that
 * image as soon as the page opens, before the agent has done anything.
 */
async function run(kind: Kind, extra: Record<string, unknown> = {}) {
  const third = await listen((_req, res) => { res.writeHead(404); res.end('no'); });
  const main = await listen((req, res) => {
    if (req.url === '/missing.png') { res.writeHead(404); res.end('no'); return; }
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const target = kind.startsWith('same') ? '/missing.png' : `${third.origin}/missing.png`;
    const early = kind.endsWith('-load') ? `<img src="${target}" alt="x">` : '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>App</title><h1>App</h1>${early}<button onclick="var i=new Image();i.src='${target}';document.body.appendChild(i)">Go</button>`);
  });
  const dir = await mkdtemp(join(tmpdir(), 'okproof-attr-'));
  await writeFile(join(dir, '7.md'), '## #7 App\n- [ ] The Go button works\n');
  try {
    const steps: ScriptedStep[] = [
      (req) => ({ toolCalls: [{ name: 'click', input: { ref: refOf(req.messages, 'button', 'Go') } }] }),
      { toolCalls: [{ name: 'conclude', input: { holds: true, summary: 'works' } }] },
    ];
    const runs = await verify({ dir, baseUrl: main.origin, model: new ScriptedModel(steps), maxSteps: 6, ...extra } as VerifyOptions);
    return runs[0]!.results[0]!;
  } finally {
    await stop(main.server);
    await stop(third.server);
    await rm(dir, { recursive: true, force: true });
  }
}

test('6: a same-origin 404 caused by the agent clicking still refutes', { skip, timeout: 120000 }, async () => {
  const r = await run('same-click');
  assert.equal(r.verdict, 'refuted');
});

test('6: an unrelated third-party 404 after a click no longer refutes; it is a severity 1 warning', { skip, timeout: 120000 }, async () => {
  const r = await run('third-click');
  assert.notEqual(r.verdict, 'refuted');
  const f = r.findings.find((x) => x.kind === 'http-error');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.severity, 1);
});

test('6: a failure already present when the page loaded does not refute (the agent did not cause it)', { skip, timeout: 120000 }, async () => {
  const r = await run('same-load');
  assert.notEqual(r.verdict, 'refuted');
});

test('6: strictDetectors restores the old page-global behaviour', { skip, timeout: 120000 }, async () => {
  assert.equal((await run('third-click', { strictDetectors: true })).verdict, 'refuted');
  assert.equal((await run('same-load', { strictDetectors: true })).verdict, 'refuted');
});
