import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function ingest(extraEnv: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'okayd-cli-'));
  const dir = join(root, '.okayd');
  await mkdir(dir);
  await writeFile(join(dir, '1.md'), '## #1 Demo\n- [ ] Does the thing\n');
  const xml = join(root, 'junit.xml');
  await writeFile(xml, '<testsuite><testcase name="does it [okayd:1.1]"/></testsuite>');
  const summary = join(root, 'summary.md');
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary, ...extraEnv };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const r = spawnSync(process.execPath, [cli, 'ingest', xml, dir], { env, encoding: 'utf8' });
  const written = await readFile(summary, 'utf8').catch(() => '');
  return { r, written, ledger: await readFile(join(dir, 'ledger-1.json'), 'utf8') };
}

test('ingest publishes the job summary in GitHub Actions by default', async () => {
  const { r, written } = await ingest({});
  assert.equal(r.status, 0);
  assert.match(written, /Does the thing/);
});

test('OKAYD_NO_COMMENT=1 skips GitHub publishing but still writes the ledger', async () => {
  const { r, written, ledger } = await ingest({ OKAYD_NO_COMMENT: '1' });
  assert.equal(r.status, 0);
  assert.equal(written, '');
  assert.match(r.stdout, /1\/1 criteria met, proven/);
  assert.equal(JSON.parse(ledger).proven, true);
});
