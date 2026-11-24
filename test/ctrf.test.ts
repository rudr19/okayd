import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCTRF } from '../src/index.js';

const report = (tests: object[]) => ({ results: { tool: { name: 'x' }, summary: {}, tests } });

test('maps CTRF statuses, including flaky via flag and via retries', () => {
  const out = parseCTRF(
    report([
      { name: 'a', status: 'passed', duration: 1250 },
      { name: 'b', status: 'passed', duration: 100, flaky: true },
      { name: 'c', status: 'passed', duration: 100, retries: 2 },
      { name: 'd', status: 'passed', duration: 100, retries: 0 },
      { name: 'e', status: 'failed', duration: 500, filePath: 'tests/e.spec.ts' },
      { name: 'f', status: 'skipped', duration: 0 },
      { name: 'g', status: 'pending', duration: 0 },
      { name: 'h', status: 'other', duration: 0 },
    ]),
  );
  assert.deepEqual(
    out.map((o) => o.status),
    ['passed', 'flaky', 'flaky', 'passed', 'failed', 'skipped', 'skipped', 'other'],
  );
  assert.equal(out[0].evidence, 'passed in 1.3s');
  assert.equal(out[4].evidence, 'failed in 0.5s (tests/e.spec.ts)');
});

test('accepts a JSON string and uses trace or screenshot attachments as evidence', () => {
  const json = JSON.stringify(
    report([
      {
        name: 'a',
        status: 'failed',
        duration: 10,
        attachments: [
          { name: 'log', contentType: 'text/plain', path: 'out.log' },
          { name: 'trace', contentType: 'application/zip', path: 'test-results/a/trace.zip' },
        ],
      },
      { name: 'b', status: 'failed', duration: 10, attachments: [{ name: 'screenshot', contentType: 'image/png', path: 'shot.png' }] },
    ]),
  );
  const out = parseCTRF(json);
  assert.equal(out[0].evidence, 'test-results/a/trace.zip');
  assert.equal(out[1].evidence, 'shot.png');
});

test('throws a clear error when results.tests is missing', () => {
  assert.throws(() => parseCTRF({ results: {} }), /results\.tests/);
  assert.throws(() => parseCTRF('{}'), /results\.tests/);
  assert.throws(() => parseCTRF('nope'), /Not valid CTRF JSON/);
});

test('okproof ingest reads a .json file as CTRF and writes a ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-ctrf-'));
  await writeFile(join(dir, '900.md'), '## #900 Home\n- [ ] Heading\n- [ ] Skip link\n');
  const file = join(dir, 'ctrf-report.json');
  await writeFile(
    file,
    JSON.stringify(
      report([
        { name: 'heading [okproof:900.1]', status: 'passed', duration: 100 },
        { name: 'skip [okproof:900.2]', status: 'passed', duration: 100, flaky: true },
      ]),
    ),
  );
  const cli = join(process.cwd(), 'dist', 'src', 'cli.js');
  const run = spawnSync(process.execPath, [cli, 'ingest', file, dir], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(run.status, 0, run.stderr);
  const ledger = JSON.parse(await readFile(join(dir, 'ledger-900.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((e: { verdict: string }) => e.verdict), ['met', 'failed']);
  assert.equal(ledger.proven, false);

  const bad = spawnSync(process.execPath, [cli, 'ingest', file, dir, '--format', 'bogus'], { cwd: dir, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
