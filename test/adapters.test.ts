import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJUnit, finalize, OkproofPlaywrightReporter } from '../src/index.js';

async function proofDir() {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-'));
  await writeFile(join(dir, '900.md'), '## #900 Home\n- [ ] Heading\n- [ ] Skip link\n- [ ] Ask panel\n');
  return dir;
}

test('parses JUnit testcases with pass, failure, error and skip', () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="s">
    <testcase name="heading [okproof:900.1]" classname="home" time="1.25"/>
    <testcase name="skip &amp; jump [okproof:900.2]" time="0.5"><failure message="nope">stack</failure></testcase>
    <testcase name="err"><error/></testcase>
    <testcase name="later"><skipped/></testcase>
  </testsuite></testsuites>`;
  assert.deepEqual(parseJUnit(xml), [
    { title: 'heading [okproof:900.1]', status: 'passed', evidence: 'passed in 1.3s (home)' },
    { title: 'skip & jump [okproof:900.2]', status: 'failed', evidence: 'failed in 0.5s' },
    { title: 'err', status: 'failed', evidence: 'failed' },
    { title: 'later', status: 'skipped', evidence: 'skipped' },
  ]);
});

test('finalize writes ledgers from JUnit outcomes', async () => {
  const dir = await proofDir();
  const xml = '<testcase name="a [okproof:900.1]"/><testcase name="b [okproof:900.2]"><failure/></testcase>';
  const { lines } = await finalize(parseJUnit(xml), { dir, github: false });
  assert.deepEqual(lines, ['okproof #900: 1/3 criteria met, not proven']);
  const ledger = JSON.parse(await readFile(join(dir, 'ledger-900.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((e: { verdict: string }) => e.verdict), ['met', 'failed', 'untested']);
});

function pwTest(title: string) {
  return { title, id: title, titlePath: () => ['file.spec.ts', title] };
}

test('Playwright reporter: a pass after a retry is flaky, traces become evidence', async () => {
  const dir = await proofDir();
  const r = new OkproofPlaywrightReporter({ dir, github: false });
  r.onTestEnd(pwTest('heading [okproof:900.1]'), { status: 'passed', retry: 0, duration: 1200, attachments: [] });
  r.onTestEnd(pwTest('skip [okproof:900.2]'), { status: 'failed', retry: 0, duration: 900, attachments: [] });
  r.onTestEnd(pwTest('skip [okproof:900.2]'), {
    status: 'passed', retry: 1, duration: 800,
    attachments: [{ name: 'trace', path: 'test-results/skip/trace.zip', contentType: 'application/zip' }],
  });
  const log = console.log;
  console.log = () => {};
  try {
    await r.onEnd();
  } finally {
    console.log = log;
  }
  const ledger = JSON.parse(await readFile(join(dir, 'ledger-900.json'), 'utf8'));
  assert.equal(ledger.entries[0].verdict, 'met');
  assert.equal(ledger.entries[0].tests[0].evidence, 'passed in 1.2s');
  assert.equal(ledger.entries[1].verdict, 'failed', 'flaky never counts as proven');
  assert.equal(ledger.entries[1].tests[0].evidence, 'test-results/skip/trace.zip');
  assert.equal(r.printsToStdio(), false);
});
