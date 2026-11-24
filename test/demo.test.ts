import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ledger } from '../src/ledger.js';
import { skip } from './verify-fixture.js';

const script = fileURLToPath(new URL('../../examples/demo/run-demo.mjs', import.meta.url));

// Async on purpose: the demo serves its own app and must not be blocked by us.
function runDemo(out: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, DEMO_OUT: out } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 150000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('demo: agent says done 5/5, okproof shows 3 met, 1 failed, 1 untested, and the gate exits 1', { skip, timeout: 180000 }, async () => {
  const out = await mkdtemp(join(tmpdir(), 'okproof-demo-'));
  try {
    const r = await runDemo(out);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const ledger = JSON.parse(await readFile(join(out, '.okproof', 'ledger-101.json'), 'utf8')) as Ledger;
    const count = (v: string): number => ledger.entries.filter((e) => e.verdict === v).length;
    assert.equal(ledger.entries.length, 5);
    assert.deepEqual([count('met'), count('failed'), count('untested')], [3, 1, 1]);
    assert.deepEqual(ledger.entries.map((e) => e.verdict), ['met', 'met', 'met', 'failed', 'untested']);
    assert.equal(ledger.proven, false);

    // The verifier's refutation was confirmed by replay and folded into the ledger.
    const failed = ledger.entries[3]!;
    assert.ok(failed.tests.some((t) => /refuted by verifier: Note is lost after a page reload/.test(t.evidence ?? '')), JSON.stringify(failed));

    const md = await readFile(join(out, 'ledger-101.md'), 'utf8');
    assert.match(md, /Not proven: 3 of 5 criteria met/);
    assert.match(r.stdout, /Agent says: Done \(5\/5\)/);
    assert.match(r.stdout, /okproof: 3 met · 1 failed · 1 untested — NOT PROVEN/);
    assert.match(r.stdout, /Gate: exit 1/);
    assert.ok((await stat(join(out, 'before-reload.png'))).size > 1000);
    assert.ok((await stat(join(out, 'after-reload.png'))).size > 1000);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
