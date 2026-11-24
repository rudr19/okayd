// Audit gaps 1 and 2: the gate must not trust a committed ledger, and a proof
// file renamed or swapped for another issue must not dodge the drift checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const actionYml = fileURLToPath(new URL('../../action.yml', import.meta.url));
const trustDoc = fileURLToPath(new URL('../../docs/trust.md', import.meta.url));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function okproof(args: string[], cwd?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const PROOF = '## #7 Demo\n- [ ] First thing works\n- [ ] Second thing works\n';
const PASSING = '<testsuite><testcase name="a [okproof:7.1]"/><testcase name="b [okproof:7.2]"/></testsuite>';
const FAILING = '<testsuite><testcase name="a [okproof:7.1]"><failure message="boom"/></testcase><testcase name="b [okproof:7.2]"/></testsuite>';

/** A hand-written ledger that says everything is met. No test run ever produced it. */
function forgedLedger(): string {
  return JSON.stringify({
    issue: '7',
    title: 'Demo',
    proven: true,
    entries: [
      { id: '7.1', text: 'First thing works', verdict: 'met', tests: [{ title: 'a [okproof:7.1]', status: 'passed', assertions: 1 }] },
      { id: '7.2', text: 'Second thing works', verdict: 'met', tests: [{ title: 'b [okproof:7.2]', status: 'passed', assertions: 1 }] },
    ],
  });
}

async function project(proofs: Record<string, string> = { '7.md': PROOF }) {
  const root = await mkdtemp(join(tmpdir(), 'okproof-trust-'));
  const dir = join(root, '.okproof');
  await mkdir(dir);
  for (const [name, text] of Object.entries(proofs)) await writeFile(join(dir, name), text);
  return { root, dir };
}

test('1a: a forged all-met ledger plus failing results fails gate --results', async () => {
  const { root, dir } = await project();
  try {
    await writeFile(join(dir, 'ledger-7.json'), forgedLedger());
    const xml = join(root, 'junit.xml');
    await writeFile(xml, FAILING);
    const r = okproof(['gate', '--results', xml, dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#7 criterion 7\.1 is failed/);
    assert.doesNotMatch(r.out, /not bound to a test run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1a: gate --results ignores a committed ledger even when no test claims a criterion', async () => {
  const { root, dir } = await project();
  try {
    await writeFile(join(dir, 'ledger-7.json'), forgedLedger());
    const xml = join(root, 'junit.xml');
    await writeFile(xml, '<testsuite><testcase name="unrelated"/></testsuite>');
    const r = okproof(['gate', '--results', xml, dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /criterion 7\.1 is untested/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1a: gate --results passes when the results really prove every criterion, with no ledger on disk', async () => {
  const { root, dir } = await project();
  try {
    const xml = join(root, 'junit.xml');
    await writeFile(xml, PASSING);
    const r = okproof(['gate', '--results', xml, dir]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /#7: 2\/2 criteria met/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1a: gate --results reads CTRF with --format', async () => {
  const { root, dir } = await project();
  try {
    const json = join(root, 'ctrf.json');
    await writeFile(json, JSON.stringify({ results: { tests: [{ name: 'a [okproof:7.1]', status: 'failed' }, { name: 'b [okproof:7.2]', status: 'passed' }] } }));
    const r = okproof(['gate', '--results', json, '--format', 'ctrf', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /criterion 7\.1 is failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1c: gate without --results still passes a forged ledger, but warns it is not bound to a test run', async () => {
  const { root, dir } = await project();
  try {
    await writeFile(join(dir, 'ledger-7.json'), forgedLedger());
    const r = okproof(['gate', dir]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ledger is not bound to a test run in this job/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1c: ingest records results_sha256 and proof_sha256 in the ledger', async () => {
  const { root, dir } = await project();
  try {
    const xml = join(root, 'junit.xml');
    await writeFile(xml, PASSING);
    assert.equal(okproof(['ingest', xml, dir]).status, 0);
    const ledger = JSON.parse(await readFile(join(dir, 'ledger-7.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(ledger.results_sha256, sha(PASSING));
    assert.equal(ledger.proof_sha256, sha(PROOF));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('1b: the Action gates from the results it just ingested and warns loudly without them', async () => {
  const yml = await readFile(actionYml, 'utf8');
  const gate = yml.slice(yml.indexOf('- name: Gate'));
  assert.match(gate, /gate --results "\$RESULTS"/);
  assert.match(gate, /::warning::/);
  assert.match(gate, /not bound to a test run/);
});

test('1d: the docs recommend not committing ledgers', async () => {
  const doc = await readFile(trustDoc, 'utf8');
  assert.match(doc, /\.okproof\/ledger-\*/);
});

// ---- gap 2 ----

test('2: replacing 142.md with a proof file for another issue fails --require-issues for the linked issue', async () => {
  const hard = '## #142 Hard\n- [ ] Hard thing one\n- [ ] Hard thing two\n';
  const { root, dir } = await project({ '7.md': PROOF, '142.md': hard });
  try {
    const xml = join(root, 'junit.xml');
    await writeFile(
      xml,
      '<testsuite><testcase name="a [okproof:7.1]"/><testcase name="b [okproof:7.2]"/><testcase name="x [okproof:142.1]"/><testcase name="y [okproof:142.2]"/></testsuite>',
    );
    assert.equal(okproof(['gate', '--results', xml, '--require-issues', '142', dir]).status, 0);
    // The swap: the hard proof file is replaced by one for an easy "issue" the PR never linked.
    await rm(join(dir, '142.md'));
    await writeFile(join(dir, '9.md'), '## #9 Easy\n- [ ] Trivial\n');
    await writeFile(xml, '<testsuite><testcase name="t [okproof:9.1]"/><testcase name="a [okproof:7.1]"/><testcase name="b [okproof:7.2]"/></testsuite>');
    const r = okproof(['gate', '--results', xml, '--require-issues', '142', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#142 is linked by the pull request but there is no proof file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2: --require-issues demands one proof file per linked issue', async () => {
  const { root, dir } = await project();
  try {
    const xml = join(root, 'junit.xml');
    await writeFile(xml, PASSING);
    const r = okproof(['gate', '--results', xml, '--require-issues', '7,8', dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#8 is linked by the pull request but there is no proof file/);
    assert.doesNotMatch(r.out, /#7 is linked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2: a proof file whose heading names a different issue than its filename fails the gate', async () => {
  const { root, dir } = await project({ '9.md': PROOF });
  try {
    const xml = join(root, 'junit.xml');
    await writeFile(xml, PASSING);
    const r = okproof(['gate', '--results', xml, dir]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /9\.md: heading says #7 but the file is named for #9/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2: sync --check fails when the proof file heading is another issue than its filename', async () => {
  const { root, dir } = await project({ '142.md': '## #7 Easy\n- [ ] Trivial\n' });
  try {
    const body = join(root, 'body.md');
    await writeFile(body, '## Hard\n- [ ] Hard thing one\n');
    const r = okproof(['sync', '--issue', '142', '--body-file', body, '--check', '.okproof'], root);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /describes issue #7, not #142/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('2: the Action requires a proof file for every linked issue', async () => {
  const yml = await readFile(actionYml, 'utf8');
  assert.match(yml, /--require-issues/);
});
