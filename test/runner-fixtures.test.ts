// E-16: runner output shaped like the real thing, and what okproof makes of it.
//
// Provenance, stated plainly: node-test-reporter.xml was captured from `node --test
// --test-reporter=junit` (host name and local paths redacted). The others are written by hand
// in each runner's documented report format (pytest junit_family=xunit2, gotestsum, jest-junit
// defaults, Maven Surefire with flakyFailure/rerunFailure, Vitest, Playwright, Cypress with
// mocha-junit-reporter, PHPUnit with assertions=, a CTRF report with retries). They are not
// captured runs, so a runner release that changes its format needs a new capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJUnit } from '../src/junit.js';
import { parseCTRF } from '../src/ctrf.js';
import { parseResults } from '../src/trust.js';
import { buildLedger } from '../src/ledger.js';
import { parseProof } from '../src/proof.js';

const dir = fileURLToPath(new URL('../../test/fixtures/runners/', import.meta.url));
const load = (name: string): string => readFileSync(join(dir, name), 'utf8');
const summary = (outcomes: Array<{ status: string; title: string }>): string[] => outcomes.map((o) => `${o.status}:${o.title}`);

const EXPECTED: Record<string, string[]> = {
  'pytest-xunit2.xml': [
    'passed:test_sign_in[[okproof:1.1]]',
    'passed:test_sign_out[[okproof:1.2]-admin]',
    'failed:test_sign_out[[okproof:1.2]-viewer]',
    'skipped:test_reset[[okproof:1.3]]',
    'passed:test_untagged',
  ],
  'gotestsum.xml': [
    'passed:TestLogin',
    'passed:TestLogin/sign_in_[okproof:2.1]',
    'failed:TestLogin/sign_out_[okproof:2.2]',
    'skipped:TestReset_[okproof:2.3]',
  ],
  'jest-junit.xml': ['passed:auth sign in works [okproof:3.1]', 'failed:auth totals use <b> & markup [okproof:3.2]', 'passed:auth plain untagged'],
  'surefire-flaky.xml': ['passed:signInWorks [okproof:4.1]', 'flaky:signOutWorks [okproof:4.2]', 'flaky:resetAfterRerun [okproof:4.3]', 'skipped:neverRuns [okproof:4.4]'],
  'vitest.xml': ['passed:auth > signs in [okproof:5.1]', 'failed:auth > signs out [okproof:5.2]', 'skipped:auth > resets [okproof:5.3]', 'passed:auth > no tag'],
  'playwright.xml': [
    'passed:auth › member signs in [okproof:6.1]',
    'failed:auth › member signs out [okproof:6.2]',
    'skipped:auth › reset is skipped [okproof:6.3]',
    // Playwright's JUnit reporter does not mark a retried-then-passed test: it is a plain pass here
    // (the okproof/playwright reporter or CTRF carry retries).
    'passed:auth › retried then passed [okproof:6.4]',
  ],
  'cypress-mocha.xml': ['passed:Auth signs in [okproof:7.1]', 'failed:Auth signs out [okproof:7.2]', 'passed:Auth untagged'],
  'phpunit-assertions.xml': ['passed:testSignIn [okproof:8.1]', 'passed:testSignOutNoAssert [okproof:8.2]', 'passed:testReset [okproof:8.3]'],
  'node-test-reporter.xml': ['passed:member signs in [okproof:10.1]', 'failed:member signs out [okproof:10.2]', 'skipped:reset is later [okproof:10.3]'],
  'ctrf-retries.json': [
    'passed:member signs in [okproof:11.1]',
    'flaky:member signs out [okproof:11.2]',
    'failed:member resets [okproof:11.3]',
    'skipped:member exports [okproof:11.4]',
    'other:member imports [okproof:11.5]',
    'flaky:retried clean [okproof:11.6]',
  ],
};

test('ten runner-shaped reports parse to the statuses a reader of the report would expect', () => {
  assert.equal(Object.keys(EXPECTED).length, 10);
  for (const [file, want] of Object.entries(EXPECTED)) {
    const text = load(file);
    const outcomes = file.endsWith('.json') ? parseCTRF(text) : parseJUnit(text);
    assert.deepEqual(summary(outcomes), want, file);
    // the format sniffer in trust.ts agrees with the direct parser
    assert.deepEqual(summary(parseResults(text, file)), want, `${file} via parseResults`);
  }
});

test('markup inside system-out, CDATA and stack traces never becomes a test', () => {
  for (const file of ['pytest-xunit2.xml', 'surefire-flaky.xml', 'playwright.xml', 'cypress-mocha.xml', 'node-test-reporter.xml']) {
    const titles = parseJUnit(load(file)).map((o) => o.title).join('\n');
    assert.ok(!titles.includes('decoy'), file);
    assert.ok(!titles.includes('not real'), file);
    assert.ok(!titles.includes('okproof:1.9') && !titles.includes('okproof:4.9'), file);
  }
});

test('runner-specific evidence: Surefire flaky and rerun are flaky, PHPUnit assertion counts and CTRF extra.assertions are kept', () => {
  const sure = parseJUnit(load('surefire-flaky.xml'));
  assert.deepEqual(sure.filter((o) => o.status === 'flaky').length, 2);
  const php = parseJUnit(load('phpunit-assertions.xml'));
  assert.deepEqual(php.map((o) => o.assertions), [3, 0, undefined]);
  const ctrf = parseCTRF(load('ctrf-retries.json'));
  assert.equal(ctrf[0]!.assertions, 2);
  assert.equal(ctrf[1]!.evidence, 'test-results/signs-out/trace.zip', 'a trace attachment is the evidence');
});

test('ledgers built from the fixtures follow the rules: one failing parameter case fails the criterion; flaky and skipped never count', () => {
  const pytest = parseJUnit(load('pytest-xunit2.xml'));
  const l1 = buildLedger(parseProof('## #1 Auth\n- [ ] sign in\n- [ ] sign out\n- [ ] reset\n'), pytest);
  assert.deepEqual(l1.entries.map((e) => e.verdict), ['met', 'failed', 'failed']);

  const ctrf = parseCTRF(load('ctrf-retries.json'));
  const l2 = buildLedger(parseProof('## #11 T\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f\n'), ctrf);
  assert.deepEqual(l2.entries.map((e) => e.verdict), ['met', 'failed', 'failed', 'failed', 'failed', 'failed']);

  const php = parseJUnit(load('phpunit-assertions.xml'));
  const l3 = buildLedger(parseProof('## #8 T\n- [ ] a\n- [ ] b\n- [ ] c\n'), php);
  assert.deepEqual(l3.entries.map((e) => e.verdict), ['met', 'unproven', 'met']);

  const gotest = parseJUnit(load('gotestsum.xml'));
  const l4 = buildLedger(parseProof('## #2 T\n- [ ] a\n- [ ] b\n- [ ] c\n'), gotest);
  assert.deepEqual(l4.entries.map((e) => e.verdict), ['met', 'failed', 'failed']);
});

// The research report listed these as open on 0.2.0 (B-04, B-05, B-06). They are fixed on this
// release; these one-liners are the evidence.
test('B-04: a testcase inside an XML comment or CDATA is not a test', () => {
  assert.deepEqual(parseJUnit('<testsuite><!-- <testcase name="x [okproof:1.1]"/> --></testsuite>'), []);
  assert.deepEqual(parseJUnit('<testsuite><system-out><![CDATA[<testcase name="x [okproof:1.1]"/>]]></system-out></testsuite>'), []);
});

test('B-05: a huge numeric character reference does not crash, and hex references decode', () => {
  assert.doesNotThrow(() => parseJUnit('<testcase name="a &#99999999; b [okproof:1.1]"/>'));
  assert.equal(parseJUnit('<testcase name="&#x41;BC [okproof:1.1]"/>')[0]!.title, 'ABC [okproof:1.1]');
});

test('B-06: single-quoted attributes are read', () => {
  assert.equal(parseJUnit("<testcase name='a [okproof:1.1]'/>")[0]!.title, 'a [okproof:1.1]');
});
