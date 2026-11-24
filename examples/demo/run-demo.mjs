// `npm run demo`: an agent says "Done (5/5)". okproof checks the claim.
//
// Everything is local and scripted. No model API is called and no credential is
// read: the "agent" is a fixed message (AGENT_CLAIM.md), and the verifier runs
// on a ScriptedModel that replays a fixed sequence of tool calls.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
process.chdir(root); // keeps every path in the ledger relative to the repo
const rel = (...p) => relative(root, join(here, ...p)).replace(/\\/g, '/');

// DEMO_OUT redirects the output folder (the test uses it to leave the committed files alone).
const outAbs = process.env.DEMO_OUT ? resolve(process.env.DEMO_OUT) : join(here, 'out');
const OUT = relative(root, outAbs).replaceAll('\\', '/');
const DIR = `${OUT}/.okproof`;
const JUNIT = `${OUT}/junit.xml`;
const CLI = 'dist/src/cli.js';

if (!existsSync(resolve(root, 'dist', 'src', 'cli.js'))) {
  console.error('Build first: npm run build (npm run demo does this for you).');
  process.exit(1);
}

const { Browser } = await import('../../dist/src/driver/index.js');
const { ScriptedModel, verifyOne, criteriaHash } = await import('../../dist/src/verify/index.js');
const { parseSnapshotRefs } = await import('../../dist/src/verify/index.js');
const { parseProof } = await import('../../dist/src/proof.js');
const { startServer } = await import('./app/server.mjs');
const { addNote, browserSkipReason, open } = await import('./lib.mjs');

const skip = browserSkipReason();
if (skip) {
  console.log(`Demo skipped: ${skip}.`);
  process.exit(0);
}

/** Runs a node child process without blocking this process, which is serving the app. */
function run(args, env = {}) {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT is set when we run inside node --test, and makes a nested --test skip its files.
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// A scripted "model": types a note, reloads, and reports that the note is gone.
// Refs come from the latest snapshot it was shown, as a real model's would.
const NOTE = 'Remember the milk';
const shown = (req) => {
  const m = req.messages[req.messages.length - 1];
  return m.role === 'user' ? m.text : m.role === 'tool' ? m.results.map((r) => r.text).join('\n') : '';
};
const refIn = (req, role, name) => {
  const hit = parseSnapshotRefs(shown(req)).find((e) => e.role === role && e.name === name);
  if (!hit) throw new Error(`scripted verifier: no ${role} "${name}" in the snapshot`);
  return hit.ref;
};
const scriptedVerifier = () =>
  new ScriptedModel([
    (req) => ({ toolCalls: [{ name: 'type', input: { ref: refIn(req, 'textbox', 'Note'), text: NOTE } }] }),
    (req) => ({ toolCalls: [{ name: 'click', input: { ref: refIn(req, 'button', 'Add note') } }] }),
    { toolCalls: [{ name: 'reload', input: {} }] },
    {
      toolCalls: [
        {
          name: 'report_violation',
          input: {
            title: 'Note is lost after a page reload',
            expected: 'A note that was added is still listed after reloading the page',
            actual: 'The list is empty after the reload',
          },
        },
      ],
    },
    { toolCalls: [{ name: 'assert_text', input: { text: NOTE, present: true } }] },
    { toolCalls: [{ name: 'conclude', input: { holds: false, summary: 'Notes do not survive a reload.' } }] },
  ]);

const server = await startServer();
let outcome;
try {
  // Fresh output folder, with the proof file copied in so the source stays clean.
  rmSync(resolve(root, OUT, '.okproof'), { recursive: true, force: true });
  rmSync(resolve(root, JUNIT), { force: true });
  mkdirSync(resolve(root, DIR), { recursive: true });
  copyFileSync(join(here, '.okproof', '101.md'), resolve(root, DIR, '101.md'));

  console.log(`App: ${server.url}  (Team notes, issue #101)\n`);

  // 1. The tests, with node's own junit reporter. A failing test must not stop the demo.
  console.log('1. Running the browser tests (node:test, junit reporter, okproof driver)...');
  const tests = await run(
    ['--test', '--test-reporter=junit', `--test-reporter-destination=${JUNIT}`, rel('tests', 'notes.test.mjs')],
    { DEMO_URL: server.url },
  );
  console.log(`   node --test exited ${tests.status} (101.4 is meant to fail); wrote ${JUNIT}`);
  if (!existsSync(resolve(root, JUNIT))) {
    console.error(tests.stdout + tests.stderr);
    throw new Error('The test run wrote no JUnit file.');
  }

  // 2. The verifier, scripted: its claim only counts if a fresh-browser replay reproduces it.
  console.log('2. Verifier on criterion 101.4 (ScriptedModel, no model API), then replay in a fresh browser...');
  const proof = parseProof(readFileSync(join(here, '.okproof', '101.md'), 'utf8'));
  const criterion = proof.criteria.find((c) => c.id === '101.4');
  const result = await verifyOne(criterion, { dir: DIR, baseUrl: server.url, model: scriptedVerifier(), maxSteps: 12 });
  const confirmed = result.findings.filter((f) => f.confirmed);
  console.log(`   verdict: ${result.verdict}; ${confirmed.length} finding(s) confirmed by replay; repro: ${result.repro ?? 'none'}`);
  writeFileSync(
    resolve(root, DIR, 'verify-101.json'),
    JSON.stringify({ issue: proof.issue, title: proof.title, baseUrl: server.url, criteriaHash: criteriaHash(proof), results: [result] }, null, 2),
  );

  // 3. Ingest the junit file (the verifier's result is folded in), then gate.
  console.log('3. okproof ingest, then okproof gate...');
  const ingest = await run([CLI, 'ingest', JUNIT, DIR], { OKPROOF_NO_COMMENT: '1' }); // GitHub publishing off
  if (ingest.status !== 0) throw new Error(`okproof ingest failed:\n${ingest.stdout}${ingest.stderr}`);
  const gate = await run([CLI, 'gate', DIR]);
  const ledger = JSON.parse(readFileSync(resolve(root, DIR, 'ledger-101.json'), 'utf8'));
  copyFileSync(resolve(root, DIR, 'ledger-101.md'), resolve(root, OUT, 'ledger-101.md'));

  // 4. Screenshots: the app before and after a reload.
  console.log('4. Screenshots...');
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    await open(page, server.url);
    await addNote(page, NOTE);
    await page.evaluate('new Promise(function (r) { setTimeout(r, 150); })');
    writeFileSync(resolve(root, OUT, 'before-reload.png'), await page.screenshot());
    await page.reload();
    await page.evaluate('new Promise(function (r) { setTimeout(r, 150); })');
    writeFileSync(resolve(root, OUT, 'after-reload.png'), await page.screenshot());
  } finally {
    await browser.close();
  }

  outcome = { ledger, gate, result, confirmed };
} finally {
  await server.close();
}

// ---------------------------------------------------------------- summary
const { ledger, gate, result, confirmed } = outcome;
const count = (v) => ledger.entries.filter((e) => e.verdict === v).length;
const met = count('met');
const failed = count('failed');
const untested = count('untested');
const total = ledger.entries.length;
const agentSays = `Agent says: Done (${total}/${total})`;
const okproofSays = `okproof: ${met} met · ${failed} failed · ${untested} untested — ${ledger.proven ? 'PROVEN' : 'NOT PROVEN'}`;

const GLYPH = { met: 'met     ', failed: 'FAILED  ', untested: 'untested' };
const rule = '='.repeat(64);
console.log(['', rule, '  ' + agentSays, '  ' + okproofSays, rule].join('\n'));
for (const e of ledger.entries) console.log('  ' + GLYPH[e.verdict] + '  ' + e.id + '  ' + e.text);
console.log(rule);
console.log(`Verifier (scripted): ${result.criterionId} ${result.verdict.toUpperCase()}, ${confirmed.length ? 'confirmed by replay in a fresh browser' : 'not confirmed by replay'}`);
for (const f of confirmed) console.log(`  - ${f.title}`);
console.log(`Gate: exit ${gate.status} (${gate.status === 0 ? 'merge allowed' : 'merge blocked'})`);
console.log(`\nWrote ${OUT}/ledger-101.md, ${OUT}/before-reload.png, ${OUT}/after-reload.png`);
process.exit(0);
