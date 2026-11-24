import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReproFile } from '../src/verify/types.js';
import { skip, startApp } from './verify-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function reproDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-cli-'));
  await mkdir(join(dir, 'repro'));
  const repro: ReproFile = {
    version: 1,
    criterionId: '7.1',
    baseUrl: 'http://127.0.0.1:1', // overridden with --url
    actions: [
      { type: 'goto', url: '/' },
      { type: 'type', role: 'textbox', name: 'Note', nth: 0, text: 'hello' },
      { type: 'click', role: 'button', name: 'Save', nth: 0 },
      { type: 'reload' },
      { type: 'assertText', text: 'Stored note: hello', present: true },
    ],
    violations: [{ title: 'Saved note is lost on reload', expected: 'kept', actual: 'lost', assertIndex: 4 }],
    detectors: [],
  };
  await writeFile(join(dir, 'repro', '7.1.json'), JSON.stringify(repro));
  return dir;
}

// Async on purpose: the test's own HTTP server must keep answering while the CLI runs.
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'verify', ...args], { env: e as NodeJS.ProcessEnv });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 90000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('verify --replay-only exits 1 while the bug reproduces and 0 once it is fixed', { skip, timeout: 180000 }, async () => {
  const dir = await reproDir();
  const buggy = await startApp({ persist: false });
  const fixed = await startApp({ persist: true });
  try {
    const bad = await run(['--replay-only', '--url', buggy.url, '--dir', dir]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /7\.1: BUG REPRODUCED/);
    assert.match(bad.stdout, /still failing: Saved note is lost on reload/);

    const good = await run(['--replay-only', '--url', fixed.url, '--dir', dir]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /7\.1: not reproduced/);
  } finally {
    await buggy.close();
    await fixed.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify without a key exits 2 and explains OKPROOF_ANTHROPIC_API_KEY, ignoring ANTHROPIC_API_KEY', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-cli-'));
  try {
    await writeFile(join(dir, '7.md'), '## #7 Notes\n- [ ] x\n');
    const r = await run(['--url', 'http://127.0.0.1:1', '--dir', dir], { OKPROOF_ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY: 'dummy-not-a-real-key' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /OKPROOF_ANTHROPIC_API_KEY/);
    assert.match(r.stderr, /--replay-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify --replay-only with no repro files exits 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-cli-'));
  try {
    const r = await run(['--replay-only', '--dir', dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /No repro files/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
