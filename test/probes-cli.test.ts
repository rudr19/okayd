import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProbeApp } from './probe-fixture.js';
import { skip } from './verify-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Async on purpose: the test's own HTTP server must keep answering while the CLI runs.
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.OKPROOF_ANTHROPIC_API_KEY; // no key anywhere: probes must not need one
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'verify', ...args], { env: env as NodeJS.ProcessEnv });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function proofDir(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-pcli-'));
  await writeFile(join(dir, '5.md'), body);
  return dir;
}

test('verify --probes-only needs no key, refutes by probe, exits 1 and prints the saving', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({ lose: true });
  const dir = await proofDir('## #5 Notes\n- [ ] A saved note is still there after reloading the page\n- [ ] Admins can export users as CSV\n');
  try {
    const r = await run(['--probes-only', '--url', app.url, '--dir', dir]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /5\.1: refuted .*\[probes, 0 tokens\]/);
    assert.match(r.stdout, /confirmed \[4\] Saved data is lost after reload/);
    assert.match(r.stdout, /5\.2: inconclusive/);
    assert.match(r.stdout, /probes-only: probes refuted 1\/2 criteria with 0 model tokens/);
    assert.doesNotMatch(r.stderr, /KEY/i);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify --probes-only on a clean app exits 0 and says nothing was refuted', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({});
  const dir = await proofDir('## #5 Notes\n- [ ] A saved note is still there after reloading the page\n- [ ] The page works on a mobile phone\n');
  try {
    const r = await run(['--probes-only', '--url', app.url, '--dir', dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /probes refuted 0\/2 criteria/);
    assert.match(r.stdout, /probes-clean|could not refute/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('default verify with no key still runs the probes, then exits 2 for what needs the model', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({});
  const dir = await proofDir('## #5 Notes\n- [ ] The page works on a mobile phone\n- [ ] Admins can export users as CSV\n');
  try {
    const r = await run(['--url', app.url, '--dir', dir]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /probe narrow-viewport/);
    assert.match(r.stderr, /OKPROOF_ANTHROPIC_API_KEY/);
    assert.match(r.stderr, /--probes-only/);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('default verify refuted entirely by probes never asks for a key', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({ overflow: true });
  const dir = await proofDir('## #5 Notes\n- [ ] The page works on a mobile phone\n');
  try {
    const r = await run(['--url', app.url, '--dir', dir]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /probes covered 1\/1 criteria with 0 model tokens; model used for 0/);
    assert.equal(r.stderr, '');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('--wait-until rejects unknown values with a clear message and exit 2', async () => {
  const r = await run(['--url', 'http://127.0.0.1:1', '--wait-until', 'eventually', '--dir', '.']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--wait-until must be one of: load, domcontentloaded, networkidle/);
  const missing = await run(['--url', 'http://127.0.0.1:1', '--wait-until']);
  assert.equal(missing.status, 2);
});

test('--wait-until domcontentloaded is accepted by probes-only', { skip, timeout: 180000 }, async () => {
  const app = await startProbeApp({ overflow: true });
  const dir = await proofDir('## #5 Notes\n- [ ] The page works on a mobile phone\n');
  try {
    const r = await run(['--probes-only', '--wait-until', 'domcontentloaded', '--url', app.url, '--dir', dir]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
