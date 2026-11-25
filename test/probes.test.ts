import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBES, matchProbes, probeById, runProbe, type ProbeId } from '../src/verify/probes.js';
import { verifyWithProbes, savingsLine } from '../src/verify/probe-run.js';
import { replayOnly } from '../src/verify/run.js';
import { ScriptedModel } from '../src/verify/model.js';
import type { VerifyFile } from '../src/verify/types.js';
import { startProbeApp, type Bugs } from './probe-fixture.js';
import { skip } from './verify-fixture.js';

const ids = (c: string): string[] => matchProbes(c).map((p) => p.id);

test('criteria map to probes by whole words; unmatched criteria stay for the model', () => {
  assert.deepEqual(ids('A saved note is still there after reloading the page'), ['persistence']);
  assert.ok(ids('Submitting the order form creates one order').includes('double-submit'));
  assert.ok(ids('Submitting the order form creates one order').includes('hostile-input'));
  assert.deepEqual(ids('The page works on a mobile phone'), ['narrow-viewport']);
  assert.deepEqual(ids('Everything is keyboard accessible'), ['keyboard']);
  assert.deepEqual(ids('Using the app offline shows a message'), ['offline']);
  assert.ok(ids('The back button returns to the list').includes('back-forward'));
  assert.deepEqual(ids('Dates are formatted as ISO 8601'), [], '"formatted" is not "form"');
  assert.deepEqual(ids('Admins can export users as CSV'), []);
  assert.deepEqual(ids(''), []);
  assert.equal(PROBES.length, 7);
  assert.equal(new Set(PROBES.map((p) => p.id)).size, 7);
});

const BUGS: { name: string; bugs: Bugs; probe: ProbeId; title: RegExp; detail?: RegExp }[] = [
  { name: 'lost on reload', bugs: { lose: true }, probe: 'persistence', title: /Saved data is lost after reload/ },
  { name: 'double submit duplicates', bugs: { dup: true }, probe: 'double-submit', title: /Double click submits twice/, detail: /same request 2 times|2 list items/ },
  { name: 'overflow at 375px', bugs: { overflow: true }, probe: 'narrow-viewport', title: /does not fit a 375px phone screen/, detail: /\d+px wide in a 375px viewport/ },
  { name: 'button unreachable by Tab', bugs: { unreachable: true }, probe: 'keyboard', title: /Controls cannot be reached with the keyboard/, detail: /Buy now/ },
  { name: 'no visible focus', bugs: { noFocus: true }, probe: 'keyboard', title: /no visible focus indicator/ },
  { name: 'XSS echo', bugs: { xss: true }, probe: 'hostile-input', title: /rendered unescaped \(XSS\)/ },
  { name: 'uncaught error offline', bugs: { crashOffline: true }, probe: 'offline', title: /Uncaught exception/ },
  { name: 'blank page offline', bugs: { blankOffline: true }, probe: 'offline', title: /Page breaks when the network is lost/ },
  { name: 'back does not restore', bugs: { backBug: true }, probe: 'back-forward', title: /Back does not restore the previous page/ },
  { name: '500 on long input', bugs: { error500: true }, probe: 'hostile-input', title: /HTTP 500/ },
];

for (const b of BUGS) {
  test(`probe ${b.probe} catches: ${b.name} (replay-confirmed, no model)`, { skip, timeout: 120000 }, async () => {
    const app = await startProbeApp(b.bugs);
    try {
      const r = await runProbe(probeById(b.probe)!, { baseUrl: app.url });
      assert.equal(r.error, undefined);
      assert.equal(r.refuted, true, JSON.stringify(r.findings));
      const hit = r.findings.find((f) => b.title.test(f.title));
      assert.ok(hit, `no finding like ${b.title}: ${r.findings.map((f) => f.title).join(' | ')}`);
      assert.equal(hit.confirmed, true, 'a probe finding counts only once a fresh browser reproduces it');
      assert.ok(hit.severity >= 3);
      if (b.detail) assert.match(hit.detail, b.detail);
    } finally {
      await app.close();
    }
  });
}

test('a clean app produces no findings from any probe, and every probe really ran', { skip, timeout: 300000 }, async () => {
  const app = await startProbeApp({});
  try {
    for (const p of PROBES) {
      const r = await runProbe(p, { baseUrl: app.url });
      assert.equal(r.error, undefined, `${p.id}: ${r.error}`);
      assert.equal(r.applicable, true, `${p.id} did not apply to the clean app (${r.note}); the clean run would prove nothing`);
      assert.deepEqual(r.findings.map((f) => f.title), [], `${p.id} reported a false positive`);
      assert.equal(r.refuted, false);
      assert.ok(r.actions.some((a) => a.type === 'assertCheck' || a.type === 'assertText'), `${p.id} made no assertion`);
    }
  } finally {
    await app.close();
  }
});

test('a page with nothing to act on is not applicable, not clean-by-accident', { skip, timeout: 60000 }, async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Static</title><h1>Static</h1><p>Words only.</p>'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    for (const id of ['persistence', 'double-submit', 'hostile-input', 'back-forward', 'offline'] as ProbeId[]) {
      const r = await runProbe(probeById(id)!, { baseUrl: url });
      assert.equal(r.refuted, false);
      assert.equal(r.findings.length, 0);
      assert.ok(r.note, `${id} should say why it did not apply`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

const PROOF = `## #9 Notes
- [ ] A saved note is still there after reloading the page
- [ ] The page works on a mobile phone
- [ ] Admins can export users as CSV
`;

test('probes-only: refutes with no model, leaves the rest inconclusive, writes a repro that replays for free', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({ lose: true });
  const dir = await mkdtemp(join(tmpdir(), 'okproof-probes-'));
  try {
    await writeFile(join(dir, '9.md'), PROOF);
    const out = await verifyWithProbes({ mode: 'only', dir, baseUrl: app.url });
    const [run] = out.runs;
    assert.deepEqual(run!.results.map((r) => r.verdict), ['refuted', 'inconclusive', 'inconclusive']);
    assert.deepEqual(run!.results.map((r) => r.outcome), ['probes', 'probes-clean', 'no-probe']);
    assert.deepEqual(out.stats, { criteria: 3, refutedByProbes: 1, noMatchingProbe: 1, survivedProbes: 1, modelUsed: 0 });
    assert.match(savingsLine(out.stats, 'only'), /refuted 1\/3 criteria with 0 model tokens/);
    assert.deepEqual(run!.results[0]!.usage, { input: 0, output: 0 });
    assert.equal(out.modelError, undefined);

    const file = JSON.parse(await readFile(join(dir, 'verify-9.json'), 'utf8')) as VerifyFile;
    assert.equal(file.results[0]!.verdict, 'refuted');
    assert.equal(file.results[0]!.findings.some((f) => f.confirmed && f.severity >= 4), true);
    assert.ok(existsSync(join(dir, 'repro', '9.1.json')));

    // The saved repro is the usual model-free regression script.
    assert.equal((await replayOnly({ dir, baseUrl: app.url }))[0]!.reproduced, true);
    const fixed = await startProbeApp({});
    try {
      assert.equal((await replayOnly({ dir, baseUrl: fixed.url }))[0]!.reproduced, false);
    } finally {
      await fixed.close();
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('probes first: the model runs only for criteria no probe refuted, and a probe refutation costs nothing', { skip, timeout: 240000 }, async () => {
  const app = await startProbeApp({ lose: true });
  const dir = await mkdtemp(join(tmpdir(), 'okproof-probes-'));
  try {
    await writeFile(join(dir, '9.md'), PROOF);
    const model = new ScriptedModel([
      { toolCalls: [{ name: 'conclude', input: { holds: true, summary: 'mobile looks fine' } }] },
      { toolCalls: [{ name: 'conclude', input: { holds: true, summary: 'no csv export to test' } }] },
    ]);
    const out = await verifyWithProbes({ mode: 'first', dir, baseUrl: app.url, model });
    const r = out.runs[0]!.results;
    assert.deepEqual(r.map((x) => x.verdict), ['refuted', 'held', 'held']);
    assert.equal(model.requests.length, 2, 'the persistence criterion must not reach the model');
    assert.equal(r[0]!.usage.input + r[0]!.usage.output, 0);
    assert.deepEqual(out.stats, { criteria: 3, refutedByProbes: 1, noMatchingProbe: 1, survivedProbes: 1, modelUsed: 2 });
    assert.equal(savingsLine(out.stats, 'first'), 'probes covered 1/3 criteria with 0 model tokens; model used for 2 (1 had no matching probe, 1 survived their probes)');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('probes first with no model available: probes still run, the rest report why', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({ lose: true });
  const dir = await mkdtemp(join(tmpdir(), 'okproof-probes-'));
  try {
    await writeFile(join(dir, '9.md'), PROOF);
    const out = await verifyWithProbes({
      mode: 'first', dir, baseUrl: app.url,
      model: () => { throw new Error('no key configured'); },
    });
    assert.equal(out.runs[0]!.results[0]!.verdict, 'refuted');
    assert.equal(out.runs[0]!.results[1]!.outcome, 'no-model');
    assert.equal(out.runs[0]!.results[1]!.error, 'no key configured');
    assert.equal(out.modelError, 'no key configured');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
