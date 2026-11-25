import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProof, splitCriterionFlags, splitStableId } from '../src/proof.js';
import { buildLedger, renderLedgerMarkdown, type Ledger, type TestOutcome } from '../src/ledger.js';
import { effectiveLevel, formatLevel, genericGap, gradeEvidence, parseLevel, readAdversarial, type Adversarial } from '../src/evidence.js';
import { evaluateGate } from '../src/gate.js';
import { finalize } from '../src/finalize.js';
import { lintOutcomes } from '../src/lint.js';
import { renderComment } from '../src/github.js';
import { runTool, tools } from '../src/mcp/tools.js';
import { syncProofFile } from '../src/sync.js';
import { criteriaHash } from '../src/verify/ledger.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (cwd: string, argv: string[]) =>
  spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: 'utf8', env: { ...process.env, OKPROOF_NO_COMMENT: '1', GITHUB_ACTIONS: '', OKPROOF_MIN_LEVEL: '', OKPROOF_PROOF_MATCHES_BASE: '' } });

const PASS = (id: string, extra: Partial<TestOutcome> = {}): TestOutcome => ({ title: `works [okproof:${id}]`, status: 'passed', assertions: 2, ...extra });

// ---------------------------------------------------------------- grammar

test('the {...} block takes #id, E0-E4 and pre in any order', () => {
  assert.deepEqual(splitCriterionFlags('{E3} Payments are charged once'), { level: 3, text: 'Payments are charged once' });
  assert.deepEqual(splitCriterionFlags('{#pay E3} Payments are charged once'), { id: 'pay', level: 3, text: 'Payments are charged once' });
  assert.deepEqual(splitCriterionFlags('{E3 #pay} Payments are charged once'), { id: 'pay', level: 3, text: 'Payments are charged once' });
  assert.deepEqual(splitCriterionFlags('{#pay E3 pre} x'), { id: 'pay', level: 3, pre: true, text: 'x' });
  assert.deepEqual(splitCriterionFlags('{pre} x'), { pre: true, text: 'x' });
  assert.deepEqual(splitCriterionFlags('{  #pay   E0  } x'), { id: 'pay', level: 0, text: 'x' });
  assert.deepEqual(splitCriterionFlags('{#login} A user can sign in'), { id: 'login', text: 'A user can sign in' });
});

test('a block with no recognised token is plain text', () => {
  assert.deepEqual(splitCriterionFlags('{JSON} responses are valid'), { text: '{JSON} responses are valid' });
  assert.deepEqual(splitCriterionFlags('{} empty braces'), { text: '{} empty braces' });
  assert.deepEqual(splitCriterionFlags('no braces'), { text: 'no braces' });
  assert.deepEqual(splitCriterionFlags('{unclosed E3 text'), { text: '{unclosed E3 text' });
});

test('a typo in a recognised block is an error, never silently ignored', () => {
  assert.throws(() => splitCriterionFlags('{E5} x'), /E0, E1, E2, E3, E4/);
  assert.throws(() => splitCriterionFlags('{e3} x'), /"e3" must be one of E0/);
  assert.throws(() => splitCriterionFlags('{E03} x'), /must be one of/);
  assert.throws(() => splitCriterionFlags('{E3 E2} x'), /more than one evidence level/);
  assert.throws(() => splitCriterionFlags('{#a #b} x'), /more than one id/);
  assert.throws(() => splitCriterionFlags('{#pay urgent} x'), /Unknown token "urgent"/);
  assert.throws(() => splitCriterionFlags('{#Bad} x'), /a-z, 0-9/);
  assert.throws(() => splitCriterionFlags('{#123} x'), /contain a letter/);
  assert.throws(() => splitCriterionFlags('{E3}'), /no text/);
  assert.throws(() => splitCriterionFlags('{E3}   '), /no text/);
});

test('splitStableId still returns just the id and text', () => {
  assert.deepEqual(splitStableId('{#pay E3} Pay'), { id: 'pay', text: 'Pay' });
  assert.deepEqual(splitStableId('plain'), { text: 'plain' });
});

test('proof files carry the required level, combined with {#id} and {pre}', () => {
  const proof = parseProof(`## #142 Payments
- [ ] Default level
- [ ] {E3} Payments are charged once
- [ ] {#refund E4} A refund returns the money
- [ ] {#pay E3 pre} Existing payments still work
- [ ] {pre} Receipts still email
- [ ] {E0} Only claimed
`);
  assert.deepEqual(proof.criteria.map((c) => [c.id, c.level, c.pre, c.text]), [
    ['142.1', undefined, undefined, 'Default level'],
    ['142.2', 3, undefined, 'Payments are charged once'],
    ['142.refund', 4, undefined, 'A refund returns the money'],
    ['142.pay', 3, true, 'Existing payments still work'],
    ['142.5', undefined, true, 'Receipts still email'],
    ['142.6', 0, undefined, 'Only claimed'],
  ]);
});

test('parseLevel and formatLevel', () => {
  assert.equal(parseLevel('E3'), 3);
  assert.equal(parseLevel('0'), 0);
  assert.throws(() => parseLevel('E5'), /E0, E1, E2, E3, E4/);
  assert.throws(() => parseLevel('high'), /E0, E1/);
  assert.equal(formatLevel(2, 3), 'E2/E3 ▰▰▱');
  assert.equal(formatLevel(3, 2), 'E3/E2 ▰▰');
  assert.equal(formatLevel(0, 2), 'E0/E2 ▱▱');
  assert.equal(formatLevel(0, 0), 'E0/E0');
  assert.equal(formatLevel(4, 4), 'E4/E4 ▰▰▰▰');
});

// ----------------------------------------------------------------- levels

const grade = (over: Partial<Parameters<typeof gradeEvidence>[0]> & { tests: TestOutcome[] }) =>
  gradeEvidence({ id: '1.1', base: 'met', weak: [], ...over });

test('E0: a criterion nothing claims', () => {
  const g = grade({ base: 'untested', tests: [] });
  assert.equal(g.level, 0);
  assert.match(g.gaps[0]!, /add a test whose title carries \[okproof:1\.1\]/);
  assert.equal(g.gaps.length, 4);
});

test('E1: a tagged test passed but asserted nothing', () => {
  const t = PASS('1.1', { assertions: 0 });
  const g = grade({ base: 'unproven', tests: [t], weak: [t.title] });
  assert.equal(g.level, 1);
  assert.match(g.gaps[0]!, /add a real, non-trivial assertion/);
});

test('E1: a passing test lint calls unrelated stays at E1', () => {
  const g = grade({ tests: [PASS('1.1', { unrelatedTo: ['1.1'] })] });
  assert.equal(g.level, 1);
  assert.match(g.gaps[0]!, /never mentions what the criterion is about/);
  // Unrelated to a different criterion does not matter.
  assert.equal(grade({ tests: [PASS('1.1', { unrelatedTo: ['1.2'] })] }).level, 2);
});

test('E2: clean, non-flaky tagged tests with a real assertion', () => {
  const g = grade({ tests: [PASS('1.1')] });
  assert.equal(g.level, 2);
  assert.match(g.gaps[0]!, /survive adversarial verification/);
});

test('a failing or flaky test drops the criterion to E0', () => {
  assert.equal(grade({ base: 'failed', tests: [PASS('1.1'), { title: 'b [okproof:1.1]', status: 'failed' }] }).level, 0);
  assert.equal(grade({ base: 'failed', tests: [PASS('1.1'), { title: 'b [okproof:1.1]', status: 'flaky' }] }).level, 0);
});

test('E3 needs adversarial evidence: verify held, or a diff/revert file saying proven-by-change or covered', () => {
  const tests = [PASS('1.1')];
  assert.equal(grade({ tests, adversarial: { verified: true } }).level, 3);
  assert.equal(grade({ tests, adversarial: { byChange: true } }).level, 3);
  assert.equal(grade({ tests, adversarial: {} }).level, 2);
  // Adversarial evidence cannot lift a criterion whose tests are not even E2.
  assert.equal(grade({ base: 'unproven', tests: [PASS('1.1', { assertions: 0 })], weak: ['works [okproof:1.1]'], adversarial: { verified: true } }).level, 1);
  assert.match(grade({ tests, adversarial: { inconclusive: 'budget' } }).gaps[0]!, /ended inconclusive \(budget\).*--budget-tokens/);
});

test('E4 needs E3, a results file from this job, and a .okproof/ that matches the base branch', () => {
  const tests = [PASS('1.1')];
  const adversarial: Adversarial = { verified: true };
  assert.equal(grade({ tests, adversarial, ci: { resultsBound: true, proofMatchesBase: true } }).level, 4);
  const noBase = grade({ tests, adversarial, ci: { resultsBound: true, proofMatchesBase: false } });
  assert.equal(noBase.level, 3);
  assert.match(noBase.gaps[0]!, /differs from the base branch/);
  const noResults = grade({ tests, adversarial, ci: { resultsBound: false, proofMatchesBase: true } });
  assert.equal(noResults.level, 3);
  assert.match(noResults.gaps[0]!, /gate --results <file> --proof-matches-base/);
  // Without E3 the CI facts do not matter.
  assert.equal(grade({ tests, ci: { resultsBound: true, proofMatchesBase: true } }).level, 2);
});

// ----------------------------------------------------------------- ledger

const LEDGER_PROOF = `## #7 Pay
- [ ] Default level criterion
- [ ] {#once E3} Payments are charged once
- [ ] {#low E1} Low bar
`;

test('default required level is E2; a criterion meets it with a clean test', () => {
  const l = buildLedger(parseProof('## #7 Pay\n- [ ] A\n'), [PASS('7.1')]);
  assert.equal(l.entries[0]!.level, 2);
  assert.equal(l.entries[0]!.required, 2);
  assert.equal(l.entries[0]!.verdict, 'met');
  assert.equal(l.proven, true);
});

test('a criterion that requires E3 is insufficient on tests alone, met with adversarial evidence', () => {
  const proof = parseProof(LEDGER_PROOF);
  const outcomes = [PASS('7.1'), PASS('7.once'), PASS('7.low')];
  const plain = buildLedger(proof, outcomes);
  assert.deepEqual(plain.entries.map((e) => [e.id, e.verdict, e.level, e.required]), [
    ['7.1', 'met', 2, 2],
    ['7.once', 'insufficient', 2, 3],
    ['7.low', 'met', 2, 1],
  ]);
  assert.equal(plain.proven, false);
  assert.match(plain.entries[1]!.gaps![0]!, /survive adversarial verification/);

  const held = buildLedger(proof, outcomes, { adversarial: new Map([['7.once', { verified: true }]]) });
  assert.deepEqual(held.entries.map((e) => [e.verdict, e.level]), [['met', 2], ['met', 3], ['met', 2]]);
  assert.equal(held.proven, true);
});

test('--min-level raises the default for lines that name no level, and never lowers an explicit one', () => {
  const proof = parseProof(LEDGER_PROOF);
  const outcomes = [PASS('7.1'), PASS('7.once'), PASS('7.low')];
  const l = buildLedger(proof, outcomes, { minLevel: 3 });
  assert.deepEqual(l.entries.map((e) => [e.verdict, e.required]), [['insufficient', 3], ['insufficient', 3], ['met', 1]]);
  const zero = buildLedger(proof, outcomes, { minLevel: 0 });
  assert.deepEqual(zero.entries.map((e) => e.required), [0, 3, 1]);
  assert.equal(zero.entries[0]!.verdict, 'met');
});

test('{E0} and {E1} never loosen the test rules: an untested or weak criterion is still not met', () => {
  const proof = parseProof('## #7 Pay\n- [ ] {E0} A\n- [ ] {E1} B\n');
  const l = buildLedger(proof, [PASS('7.2', { assertions: 0 })]);
  assert.deepEqual(l.entries.map((e) => e.verdict), ['untested', 'unproven']);
});

test('a lint-flagged unrelated test is insufficient at the default level but met at {E1}', () => {
  const proof = parseProof('## #7 Pay\n- [ ] A\n- [ ] {E1} B\n');
  const l = buildLedger(proof, [PASS('7.1', { unrelatedTo: ['7.1'] }), PASS('7.2', { unrelatedTo: ['7.2'] })]);
  assert.deepEqual(l.entries.map((e) => [e.verdict, e.level]), [['insufficient', 1], ['met', 1]]);
});

test('markdown and the PR comment show a level column with a compact bar', () => {
  const proof = parseProof(LEDGER_PROOF);
  const l = buildLedger(proof, [PASS('7.1'), PASS('7.once'), PASS('7.low')]);
  const md = renderLedgerMarkdown(l);
  assert.match(md, /\| Criterion \| Verdict \| Level \| Evidence \|/);
  assert.match(md, /7\.once Payments are charged once \| INSUFFICIENT EVIDENCE \| E2\/E3 ▰▰▱ \| needs E3: survive adversarial verification/);
  assert.match(md, /7\.1 Default level criterion \| met \| E2\/E2 ▰▰ \|/);
  assert.match(md, /Levels: E0 claimed/);
  const comment = renderComment([l]);
  assert.match(comment, /not proven yet/);
  assert.match(comment, /Below the evidence level the criterion requires: #7 7\.once \(E2 of E3\)/);
  assert.match(comment, /E2\/E3 ▰▰▱/);
});

// -------------------------------------------------------- adversarial files

async function work(proofText: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okproof-evidence-'));
  await writeFile(join(dir, '7.md'), proofText);
  return dir;
}

test('readAdversarial reads verify, diff and revert files and ignores stale or malformed ones', async () => {
  const proof = parseProof(LEDGER_PROOF);
  const dir = await work(LEDGER_PROOF);
  await writeFile(
    join(dir, 'verify-7.json'),
    JSON.stringify({ issue: '7', title: 'Pay', baseUrl: 'http://x', criteriaHash: criteriaHash(proof), results: [
      { criterionId: '7.1', verdict: 'held', outcome: 'concluded', findings: [], actions: [], screenshots: [], steps: 1, usage: { input: 1, output: 1 }, criterion: 'x' },
      { criterionId: '7.low', verdict: 'inconclusive', outcome: 'budget', findings: [], actions: [], screenshots: [], steps: 1, usage: { input: 1, output: 1 }, criterion: 'x' },
    ] }),
  );
  await writeFile(join(dir, 'diff-7.json'), JSON.stringify({ results: [{ criterionId: '7.once', verdict: 'proven-by-change' }, { criterionId: '7.1', verdict: 'unchanged' }] }));
  await writeFile(join(dir, 'revert-7.json'), JSON.stringify({ criteriaHash: criteriaHash(proof), results: { '7.low': 'covered' } }));
  const map = await readAdversarial(dir, proof);
  assert.deepEqual(map.get('7.1'), { verified: true });
  assert.deepEqual(map.get('7.once'), { byChange: true });
  assert.deepEqual(map.get('7.low'), { inconclusive: 'budget', byChange: true });

  await writeFile(join(dir, 'diff-7.json'), JSON.stringify({ criteriaHash: 'stale', results: [{ criterionId: '7.once', verdict: 'proven-by-change' }] }));
  await writeFile(join(dir, 'revert-7.json'), '{ not json');
  await writeFile(join(dir, 'verify-7.json'), JSON.stringify({ criteriaHash: 'stale', results: [{ criterionId: '7.1', verdict: 'held' }] }));
  assert.equal((await readAdversarial(dir, proof)).size, 0);
});

test('finalize turns a held verify result into E3 and writes level, required and gaps to the ledger', async () => {
  const proof = parseProof(LEDGER_PROOF);
  const dir = await work(LEDGER_PROOF);
  await writeFile(
    join(dir, 'verify-7.json'),
    JSON.stringify({ issue: '7', title: 'Pay', baseUrl: 'http://x', criteriaHash: criteriaHash(proof), results: [
      { criterionId: '7.once', criterion: 'x', verdict: 'held', outcome: 'concluded', findings: [], actions: [], screenshots: [], steps: 1, usage: { input: 1, output: 1 } },
    ] }),
  );
  const { ledgers, lines } = await finalize([PASS('7.1'), PASS('7.once'), PASS('7.low')], { dir, github: false });
  assert.equal(ledgers[0]!.proven, true);
  assert.deepEqual(ledgers[0]!.entries.map((e) => e.level), [2, 3, 2]);
  const onDisk = JSON.parse(await readFile(join(dir, 'ledger-7.json'), 'utf8')) as Ledger;
  assert.equal(onDisk.entries[1]!.required, 3);
  assert.equal(onDisk.entries[1]!.gaps!.length, 1);
  assert.match(lines[0]!, /3\/3 criteria met, proven/);

  const short = await finalize([PASS('7.1'), PASS('7.once'), PASS('7.low')], { dir: await work(LEDGER_PROOF), github: false });
  assert.match(short.lines[0]!, /2\/3 criteria met, 1 below the required evidence level, not proven/);
});

test('a refuted verify result fails the criterion and sets its level to E0', async () => {
  const proof = parseProof('## #7 Pay\n- [ ] A\n');
  const dir = await work('## #7 Pay\n- [ ] A\n');
  await writeFile(
    join(dir, 'verify-7.json'),
    JSON.stringify({ issue: '7', title: 'Pay', baseUrl: 'http://x', criteriaHash: criteriaHash(proof), results: [
      { criterionId: '7.1', criterion: 'A', verdict: 'refuted', outcome: 'concluded', findings: [{ kind: 'violation', severity: 4, title: 'bug', detail: '', url: '', step: 1, confirmed: true }], actions: [], screenshots: [], steps: 1, usage: { input: 1, output: 1 } },
    ] }),
  );
  const { ledgers } = await finalize([PASS('7.1')], { dir, github: false });
  assert.equal(ledgers[0]!.entries[0]!.verdict, 'failed');
  assert.equal(ledgers[0]!.entries[0]!.level, 0);
});

// ------------------------------------------------------------------- gate

async function gateDir(proofText: string, ledger: Ledger): Promise<string> {
  const dir = await work(proofText);
  await writeFile(join(dir, `ledger-${ledger.issue}.json`), JSON.stringify(ledger));
  return dir;
}

test('gate fails a criterion short of its required level and says exactly what is missing', async () => {
  const proof = parseProof(LEDGER_PROOF);
  const ledger = buildLedger(proof, [PASS('7.1'), PASS('7.once'), PASS('7.low')]);
  const dir = await gateDir(LEDGER_PROOF, ledger);
  const r = await evaluateGate(dir);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!, /^#7 criterion 7\.once has E2 evidence but requires E3: survive adversarial verification: run okproof verify until it holds for 7\.once, or add \.okproof\/diff-7\.json or revert-7\.json marking it proven-by-change or covered\. Payments are charged once$/);
});

test('gate takes the requirement from the proof file, not from the ledger', async () => {
  const proof = parseProof(LEDGER_PROOF);
  const ledger = buildLedger(proof, [PASS('7.1'), PASS('7.once'), PASS('7.low')], { adversarial: new Map([['7.once', { verified: true }]]) });
  const dir = await gateDir(LEDGER_PROOF, ledger);
  assert.equal((await evaluateGate(dir)).ok, true);
  // The proof file now asks for E4 on one criterion; the ledger's own "required" says E3.
  const harder = LEDGER_PROOF.replace('{#once E3}', '{#once E4}');
  await writeFile(join(dir, '7.md'), harder);
  const r = await evaluateGate(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems[0]!, /7\.once has E3 evidence but requires E4: produce it in CI/);
  // Lying in the ledger does not help.
  const forged = JSON.parse(await readFile(join(dir, 'ledger-7.json'), 'utf8')) as Ledger;
  forged.entries[1]!.required = 0;
  await writeFile(join(dir, 'ledger-7.json'), JSON.stringify(forged));
  assert.equal((await evaluateGate(dir)).ok, false);
});

test('gate --min-level applies to criteria whose line names none', async () => {
  const proof = parseProof('## #7 Pay\n- [ ] A\n');
  const ledger = buildLedger(proof, [PASS('7.1')]);
  const dir = await gateDir('## #7 Pay\n- [ ] A\n', ledger);
  assert.equal((await evaluateGate(dir)).ok, true);
  const r = await evaluateGate(dir, { minLevel: 3 });
  assert.equal(r.ok, false);
  assert.match(r.problems[0]!, /7\.1 has E2 evidence but requires E3/);
  assert.equal((await evaluateGate(dir, { minLevel: 2 })).ok, true);
});

test('a ledger from before evidence levels counts as E2, so it passes E2 and fails E3', async () => {
  const legacy: Ledger = { issue: '7', title: 'Pay', proven: true, entries: [{ id: '7.1', text: 'A', verdict: 'met', tests: [] }] };
  const dir = await gateDir('## #7 Pay\n- [ ] A\n', legacy);
  assert.equal((await evaluateGate(dir)).ok, true);
  const r = await evaluateGate(dir, { minLevel: 3 });
  assert.equal(r.ok, false);
  assert.match(r.problems[0]!, /has E2 evidence but requires E3/);
  assert.equal(effectiveLevel({ verdict: 'met' }, false), 2);
  assert.equal(effectiveLevel({ verdict: 'untested' }, false), 0);
  assert.equal(effectiveLevel({ verdict: 'met', level: 99 }, false), 2);
});

test('only a ledger rebuilt in this job can be credited with E4', async () => {
  const proofText = '## #7 Pay\n- [ ] {E4} A\n';
  const proof = parseProof(proofText);
  const ledger = buildLedger(proof, [PASS('7.1')], { adversarial: new Map([['7.1', { verified: true }]]), ci: { resultsBound: true, proofMatchesBase: true } });
  assert.equal(ledger.entries[0]!.level, 4);
  const dir = await gateDir(proofText, ledger);
  // Read from disk, as a committed ledger: capped at E3.
  const committed = await evaluateGate(dir);
  assert.equal(committed.ok, false);
  assert.match(committed.problems[0]!, /has E3 evidence but requires E4: produce it in CI/);
  // Injected, as `gate --results` does: trusted.
  assert.equal((await evaluateGate(dir, { ledgers: [ledger] })).ok, true);
});

// ------------------------------------------------------------ CLI and MCP

async function project(proofText: string, junit: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'okproof-evidence-cli-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '7.md'), proofText);
  await writeFile(join(root, 'junit.xml'), junit);
  return root;
}
const JUNIT = '<testsuite><testcase name="works [okproof:7.1]"/><testcase name="works [okproof:7.2]"/></testsuite>';

test('CLI: gate --results fails below the required level; --min-level changes the default; a bad level is exit 2', async () => {
  const root = await project('## #7 Pay\n- [ ] A\n- [ ] {E3} B\n', JUNIT);
  const g = run(root, ['gate', '--results', 'junit.xml']);
  assert.equal(g.status, 1);
  assert.match(g.stderr, /7\.2 has E2 evidence but requires E3/);
  assert.doesNotMatch(g.stderr, /7\.1/);
  const strict = run(root, ['gate', '--results', 'junit.xml', '--min-level', 'E3']);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /7\.1 has E2 evidence but requires E3/);
  const bad = run(root, ['gate', '--results', 'junit.xml', '--min-level', 'E9']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /E0, E1, E2, E3, E4/);
  const lax = run(await project('## #7 Pay\n- [ ] A\n- [ ] B\n', JUNIT), ['gate', '--results', 'junit.xml', '--min-level=E1']);
  assert.equal(lax.status, 0, lax.stderr);
});

test('CLI: ingest writes levels; --proof-matches-base with gate --results lets E3 evidence reach E4', async () => {
  const root = await project('## #7 Pay\n- [ ] {E4} A\n', '<testsuite><testcase name="works [okproof:7.1]"/></testsuite>');
  const proof = parseProof('## #7 Pay\n- [ ] {E4} A\n');
  await writeFile(join(root, '.okproof', 'diff-7.json'), JSON.stringify({ criteriaHash: criteriaHash(proof), results: [{ criterionId: '7.1', verdict: 'proven-by-change' }] }));
  const noBase = run(root, ['gate', '--results', 'junit.xml']);
  assert.equal(noBase.status, 1);
  assert.match(noBase.stderr, /has E3 evidence but requires E4: the \.okproof\/ folder differs from the base branch|has E3 evidence but requires E4/);
  const ok = run(root, ['gate', '--results', 'junit.xml', '--proof-matches-base']);
  assert.equal(ok.status, 0, ok.stderr);
  // Ingest alone writes a ledger, but a committed ledger can never be credited with E4.
  assert.equal(run(root, ['ingest', 'junit.xml', '--proof-matches-base']).status, 0);
  const l = JSON.parse(await readFile(join(root, '.okproof', 'ledger-7.json'), 'utf8')) as Ledger;
  assert.equal(l.entries[0]!.level, 4);
  const committed = run(root, ['gate']);
  assert.equal(committed.status, 1);
  assert.match(committed.stderr, /has E3 evidence but requires E4/);
  // --proof-matches-base without --results is refused.
  assert.equal(run(root, ['gate', '--proof-matches-base']).status, 2);
});

test('CLI: OKPROOF_MIN_LEVEL sets the default level', async () => {
  const root = await project('## #7 Pay\n- [ ] A\n', '<testsuite><testcase name="works [okproof:7.1]"/></testsuite>');
  const r = spawnSync(process.execPath, [cli, 'gate', '--results', 'junit.xml'], { cwd: root, encoding: 'utf8', env: { ...process.env, OKPROOF_MIN_LEVEL: 'E3', GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires E3/);
});

test('okproof check shows an explicit required level', async () => {
  const root = await project('## #7 Pay\n- [ ] A\n- [ ] {#b E3} B\n', JUNIT);
  const r = run(root, ['check']);
  assert.match(r.stdout, /\[okproof:7\.1\] A\n/);
  assert.match(r.stdout, /\[okproof:7\.b\] B \(requires E3\)/);
});

test('sync keeps a criterion\'s required level and {pre} when it rewrites the proof file', async () => {
  const root = await project('## #7 Pay\n- [ ] {#a E3 pre} Alpha\n- [ ] Beta\n', JUNIT);
  const dir = join(root, '.okproof');
  await syncProofFile({ cwd: root, dir: '.okproof', issue: 7, title: 'Pay', body: '- [ ] Alpha\n- [ ] Beta\n- [ ] {E2} Gamma\n' });
  const text = await readFile(join(dir, '7.md'), 'utf8');
  assert.match(text, /- \[ \] \{#a E3 pre\} Alpha/);
  assert.match(text, /- \[ \] Beta/);
  assert.match(text, /- \[ \] \{E2\} Gamma/);
});

test('MCP okproof_status shows each level and the next step to raise it', async () => {
  const root = await project(LEDGER_PROOF.replace('## #7 Pay', '## #7 Pay'), JUNIT);
  await writeFile(join(root, '.okproof', '7.md'), LEDGER_PROOF);
  const proof = parseProof(LEDGER_PROOF);
  await writeFile(join(root, '.okproof', 'ledger-7.json'), JSON.stringify(buildLedger(proof, [PASS('7.1'), PASS('7.once'), PASS('7.low')])));
  const out = await runTool(tools.find((t) => t.name === 'okproof_status')!, {}, { cwd: root });
  const text = out.content[0]!.text;
  assert.match(text, /^Not done: 2 of 3 criteria proven/);
  assert.match(text, /INSUFFICIENT {2}7\.once Payments are charged once \[E2\/E3 ▰▰▱\]/);
  assert.match(text, /MET {2}7\.1 Default level criterion \[E2\/E2 ▰▰\]/);
  assert.match(text, /7\.once \(insufficient, E2\/E3 ▰▰▱\).*survive adversarial verification/);
  assert.match(text, /Raise the evidence \(one level at a time\):/);
  assert.match(text, /- 7\.1 E2 to E3: survive adversarial verification/);
  assert.match(text, /- 7\.once E2 to E3 \(required\): /);
});

test('lint marks a test it calls unrelated, and only for that criterion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'okproof-evidence-lint-'));
  await mkdir(join(root, '.okproof'));
  await writeFile(join(root, '.okproof', '1.md'), '## #1 Demo\n- [ ] Upload a file\n- [ ] Download a file\n');
  await writeFile(
    join(root, 'a.test.ts'),
    `test('upload a file [okproof:1.1]', async () => {\n  assert.equal(await upload('a file'), 'a file');\n});\ntest('download a file [okproof:1.2]', async () => {\n  assert.equal(compute(), 42);\n});\n`,
  );
  const l = await lintOutcomes(
    [{ title: 'upload a file [okproof:1.1]', status: 'passed' }, { title: 'download a file [okproof:1.2]', status: 'passed' }],
    { dir: root, proofDir: join(root, '.okproof') },
  );
  assert.equal(l.outcomes[0]!.unrelatedTo, undefined);
  assert.deepEqual(l.outcomes[1]!.unrelatedTo, ['1.2']);
});

test('genericGap names the step for each level', () => {
  assert.match(genericGap(1, '1.1'), /\[okproof:1\.1\]/);
  assert.match(genericGap(3, '1.1'), /okproof verify/);
  assert.match(genericGap(4, '1.1'), /--proof-matches-base/);
});
