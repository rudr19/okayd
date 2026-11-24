import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool, tools } from '../src/mcp/tools.js';

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-mcp-'));
  await mkdir(join(cwd, '.okproof'));
  await writeFile(
    join(cwd, '.okproof', '142.md'),
    '## #142 Pro upgrade\n\n- [ ] Member can upgrade\n- [ ] Invoice shows proration\n- [ ] Viewer cannot see button\n- [ ] Downgrade works\n',
  );
  return cwd;
}

async function call(cwd: string, name: string, args: Record<string, unknown> = {}) {
  const tool = tools.find((t) => t.name === name)!;
  const r = await runTool(tool, args, { cwd });
  return { text: r.content[0].text, isError: r.isError === true };
}

async function writeLedger(cwd: string, verdicts: ('met' | 'failed' | 'untested')[]) {
  const entries = verdicts.map((verdict, i) => ({
    id: `142.${i + 1}`,
    text: `c${i + 1}`,
    verdict,
    tests: verdict === 'untested' ? [] : [{ title: `t [okproof:142.${i + 1}]`, status: verdict === 'met' ? 'passed' : 'failed', evidence: `trace${i + 1}.zip` }],
  }));
  const path = join(cwd, '.okproof', 'ledger-142.json');
  await writeFile(path, JSON.stringify({ issue: '142', title: 'Pro upgrade', entries, proven: verdicts.every((v) => v === 'met') }));
  return path;
}

test('okproof_criteria lists criteria with tags', async () => {
  const cwd = await project();
  const r = await call(cwd, 'okproof_criteria');
  assert.equal(r.isError, false);
  assert.match(r.text, /#142 Pro upgrade/);
  assert.match(r.text, /\[okproof:142\.1\] Member can upgrade/);
  assert.match(r.text, /\[okproof:142\.4\] Downgrade works/);
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_criteria errors helpfully for a missing issue or folder', async () => {
  const cwd = await project();
  assert.equal((await call(cwd, 'okproof_criteria', { issue: '999' })).isError, true);
  const r = await call(cwd, 'okproof_criteria', { dir: 'nowhere' });
  assert.equal(r.isError, true);
  assert.match(r.text, /okproof_add_criterion/);
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_status without a ledger reports everything untested', async () => {
  const cwd = await project();
  const r = await call(cwd, 'okproof_status');
  assert.equal(r.isError, false);
  assert.equal(r.text.split('\n')[0], 'Not done: 0 of 4 criteria proven.');
  assert.match(r.text, /no ledger yet/);
  assert.equal((r.text.match(/UNTESTED {2}142\./g) ?? []).length, 4);
  assert.match(r.text, /Next steps:/);
  assert.match(r.text, /\[okproof:142\.4\]/);
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_status with a mixed ledger says Not done and names unmet tags', async () => {
  const cwd = await project();
  const ledger = await writeLedger(cwd, ['met', 'failed', 'untested', 'met']);
  const old = new Date(Date.now() - 60_000); // proof file older than ledger
  await utimes(join(cwd, '.okproof', '142.md'), old, old);
  const r = await call(cwd, 'okproof_status', { issue: '142' });
  assert.equal(r.text.split('\n')[0], 'Not done: 2 of 4 criteria proven.');
  assert.match(r.text, /MET {2}142\.1 .*trace1\.zip/);
  assert.match(r.text, /FAILED {2}142\.2/);
  assert.match(r.text, /- 142\.2 \(failed\).*\[okproof:142\.2\]/);
  assert.match(r.text, /- 142\.3 \(untested\).*\[okproof:142\.3\]/);
  assert.doesNotMatch(r.text, /out of date/);
  assert.ok(existsSync(ledger));
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_status says Done when every criterion is proven', async () => {
  const cwd = await project();
  await writeLedger(cwd, ['met', 'met', 'met', 'met']);
  const old = new Date(Date.now() - 60_000);
  await utimes(join(cwd, '.okproof', '142.md'), old, old);
  const r = await call(cwd, 'okproof_status');
  assert.equal(r.text.split('\n')[0], 'Done: every criterion proven.');
  assert.doesNotMatch(r.text, /Next steps/);
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_status warns when the proof file is newer than the ledger', async () => {
  const cwd = await project();
  const ledger = await writeLedger(cwd, ['met', 'met', 'met', 'met']);
  const old = new Date(Date.now() - 60_000);
  await utimes(ledger, old, old);
  const r = await call(cwd, 'okproof_status');
  assert.match(r.text, /newer than its ledger.*out of date/);
  await rm(cwd, { recursive: true, force: true });
});

test('a criterion added after the ledger counts as untested', async () => {
  const cwd = await project();
  await writeLedger(cwd, ['met', 'met', 'met']); // ledger only knows 3 of 4
  const r = await call(cwd, 'okproof_status');
  assert.equal(r.text.split('\n')[0], 'Not done: 3 of 4 criteria proven.');
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_add_criterion creates the file, then appends', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-mcp-'));
  const needTitle = await call(cwd, 'okproof_add_criterion', { issue: '7', text: 'first' });
  assert.equal(needTitle.isError, true);
  assert.match(needTitle.text, /title/);

  const first = await call(cwd, 'okproof_add_criterion', { issue: '7', text: 'Users can log in', title: 'Login' });
  assert.equal(first.isError, false);
  assert.match(first.text, /7\.1/);
  assert.match(first.text, /\[okproof:7\.1\]/);

  const second = await call(cwd, 'okproof_add_criterion', { issue: '7', text: 'Bad password is rejected' });
  assert.match(second.text, /\[okproof:7\.2\]/);

  const file = await readFile(join(cwd, '.okproof', '7.md'), 'utf8');
  assert.equal(file, '## #7 Login\n\n- [ ] Users can log in\n- [ ] Bad password is rejected\n');
  assert.equal((await call(cwd, 'okproof_add_criterion', { issue: '7', text: 'two\nlines' })).isError, true);
  await rm(cwd, { recursive: true, force: true });
});

test('okproof_ingest_junit writes a ledger', async () => {
  const cwd = await project();
  const xml = `<testsuite>
<testcase name="upgrade [okproof:142.1]" time="1.2"/>
<testcase name="proration [okproof:142.2]"><failure message="x"/></testcase>
</testsuite>`;
  await writeFile(join(cwd, 'junit.xml'), xml);
  const r = await call(cwd, 'okproof_ingest_junit', { file: 'junit.xml' });
  assert.equal(r.isError, false);
  assert.match(r.text, /okproof #142: 1\/4 criteria met, not proven/);
  const ledger = JSON.parse(await readFile(join(cwd, '.okproof', 'ledger-142.json'), 'utf8'));
  assert.equal(ledger.entries[0].verdict, 'met');
  assert.equal(ledger.entries[1].verdict, 'failed');
  const status = await call(cwd, 'okproof_status');
  assert.equal(status.text.split('\n')[0], 'Not done: 1 of 4 criteria proven.');
  assert.equal((await call(cwd, 'okproof_ingest_junit', { file: 'missing.xml' })).isError, true);
  await rm(cwd, { recursive: true, force: true });
});

test('path traversal is rejected', async () => {
  const cwd = await project();
  const cases: [string, Record<string, unknown>][] = [
    ['okproof_criteria', { dir: '../x' }],
    ['okproof_status', { dir: '../x' }],
    ['okproof_status', { issue: '../../etc' }],
    ['okproof_criteria', { issue: '../../etc' }],
    ['okproof_add_criterion', { issue: '../../etc', text: 'x', title: 't' }],
    ['okproof_add_criterion', { issue: '1', text: 'x', title: 't', dir: '../escape' }],
    ['okproof_ingest_junit', { file: '../junit.xml' }],
    ['okproof_ingest_junit', { file: 'junit.xml', dir: '../x' }],
    ['okproof_status', { dir: tmpdir() }],
  ];
  for (const [name, args] of cases) {
    const r = await call(cwd, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(existsSync(join(cwd, '..', 'escape')), false);
  await rm(cwd, { recursive: true, force: true });
});
