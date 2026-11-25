// Research findings B-05, B-06, B-07, B-08, E-16: tokenizer edge cases, lint matching by test identity, assertion call forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseJUnit, decodeEntities } from '../src/junit.js';
import { applyLintToOutcomes, analyzeSource, matchTestName } from '../src/lint.js';
import { buildLedger } from '../src/ledger.js';
import { parseProof } from '../src/proof.js';
import { judge, ASSERTION } from '../src/weak-signals.js';

const wrap = (body: string): string => `<testsuites><testsuite name="s">${body}</testsuite></testsuites>`;

test('B-05: numeric references above 0x10FFFF, surrogates and NUL never throw and stay as written', () => {
  for (const ref of ['&#99999999;', '&#1114112;', '&#x110000;', '&#xFFFFFFFFFF;', '&#0;', '&#xD800;', '&#55296;', '&#;', '&#x;', '&#xZZ;']) {
    assert.equal(decodeEntities(`a${ref}b`), `a${ref}b`, ref);
  }
  assert.doesNotThrow(() => parseJUnit(wrap('<testcase name="x &#99999999; &#x41; [okproof:1.1]"/>')));
  assert.equal(parseJUnit(wrap('<testcase name="x &#99999999; &#x41;"/>'))[0]!.title, 'x &#99999999; A');
  assert.equal(decodeEntities('&#x1F600;&#128512;'), '\u{1F600}\u{1F600}');
});

test('B-06: single-quoted attributes name the test and carry the tag', () => {
  const out = parseJUnit(wrap(`<testcase name='a [okproof:1.1]' time='2'/>`));
  assert.equal(out[0]!.title, 'a [okproof:1.1]');
  assert.equal(parseJUnit(wrap(`<testcase name='say "hi" [okproof:1.1]'/>`))[0]!.title, 'say "hi" [okproof:1.1]');
});

test('B-07: a weak test called "login" does not mark the strong "login works" weak', () => {
  const proof = parseProof('## #1 Login\n- [ ] User can log in\n');
  const weak = [{ file: 'a.spec.ts', line: 1, ids: ['1.1'], title: '', name: 'login', reason: 'none' as const }];
  const asserting = [{ file: 'b.spec.ts', line: 1, ids: ['1.1'], title: '', name: 'login works' }];
  const outcomes = [
    { title: 'login [okproof:1.1]', status: 'passed' },
    { title: 'login works [okproof:1.1]', status: 'passed' },
  ];
  const r = applyLintToOutcomes(outcomes, weak, asserting);
  assert.deepEqual(r.outcomes.map((o) => o.assertions), [0, 1]);
  assert.deepEqual(r.marked, ['login [okproof:1.1]']);
  // With only the strong test run, the criterion is met; the weak finding about a different test is ignored.
  const only = applyLintToOutcomes([outcomes[1]!], weak, asserting);
  assert.equal(buildLedger(proof, only.outcomes).entries[0]!.verdict, 'met');
  // Without an asserting finding the strong test is left alone as well.
  assert.equal(applyLintToOutcomes([outcomes[1]!], weak).outcomes[0]!.assertions, undefined);
});

test('B-07: same title in two files is told apart by file when the runner names it, else left alone', () => {
  const weak = [{ file: 'tests/a.spec.ts', line: 1, ids: ['1.1'], title: '', name: 'same', reason: 'none' as const }];
  const asserting = [{ file: 'tests/b.spec.ts', line: 1, ids: ['1.1'], title: '', name: 'same' }];
  const a = applyLintToOutcomes([{ title: 'same [okproof:1.1]', status: 'passed', file: 'tests/a.spec.ts' }], weak, asserting);
  assert.equal(a.outcomes[0]!.assertions, 0);
  const b = applyLintToOutcomes([{ title: 'same [okproof:1.1]', status: 'passed', file: 'tests/b.spec.ts' }], weak, asserting);
  assert.equal(b.outcomes[0]!.assertions, 1);
  const unknown = applyLintToOutcomes([{ title: 'same [okproof:1.1]', status: 'passed' }], weak, asserting);
  assert.equal(unknown.outcomes[0]!.assertions, undefined, 'ambiguous identity: no verdict from lint');
});

test('B-07: describe prefixes, parameter suffixes and subtests still match; substrings do not', () => {
  assert.equal(matchTestName('works', 'works'), 'exact');
  assert.equal(matchTestName('works', 'suite > works'), 'near');
  assert.equal(matchTestName('works', 'suite works'), 'near');
  assert.equal(matchTestName('test_it', 'test_it[param-1]'), 'near');
  assert.equal(matchTestName('TestA', 'TestA/sub'), 'near');
  assert.equal(matchTestName('login', 'login works'), undefined);
  assert.equal(matchTestName('login', 'relogin'), undefined);
  assert.equal(matchTestName('', 'anything'), 'near');
});

test('B-08: identifiers that merely start with "assert" are not assertions; call forms are', () => {
  const no = ['const assertions = [];', 'let assertCount = 3;', 'assertEqualCount += 1;', 'log(assertions.length);', 'const assertEqualCount = 2;'];
  for (const code of no) assert.equal(ASSERTION.test(code), false, code);
  const yes = ['assert(x)', 'assert.equal(a, 1)', 'assert.strict.equal(a, 1)', 'assertEquals(a, b)', 'self.assertEqual(a, 1)', 'mock.assert_called_once()', 'assertThat(x).isTrue()', 'assert x == 1', 'assert not done', 'expect(x).toBe(1)'];
  for (const code of yes) assert.equal(ASSERTION.test(code), true, code);
  assert.equal(judge('const assertions = []; assertions.push(1);').weak, true);
  assert.equal(judge('const assertEqualCount = 2; run(assertEqualCount);').weak, true);
  const src = `test('x [okproof:1.1]', async () => { const assertions = []; assertions.push(1); });\n`;
  assert.equal(analyzeSource(src, false).tests[0]!.weak, true);
});

test('B-08: ASSERTION stays linear on adversarial input', () => {
  const t0 = Date.now();
  ASSERTION.test('assert'.repeat(50_000) + ' ' .repeat(50_000));
  ASSERTION.test('assert.'.repeat(30_000));
  ASSERTION.test('assert' + ' .a'.repeat(30_000));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

// E-16: fuzz with entities, comments and CDATA.
const piece = fc.oneof(
  fc.constant('<testsuite>'),
  fc.constant('</testsuite>'),
  fc.constant('<testcase name="a [okproof:1.1]">'),
  fc.constant("<testcase name='b [okproof:1.2]'/>"),
  fc.constant('</testcase>'),
  fc.constant('<failure message="x"/>'),
  fc.constant('<!-- <testcase name="ghost [okproof:1.1]"/> -->'),
  fc.constant('<!--'),
  fc.constant('-->'),
  fc.constant('<![CDATA[ <testcase name="cd [okproof:1.1]"/> ]]>'),
  fc.constant('<![CDATA['),
  fc.constant(']]>'),
  fc.constant('&#99999999;'),
  fc.constant('&#x110000;'),
  fc.constant('&#x41;'),
  fc.constant('&amp;'),
  fc.constant('&'),
  fc.constant('<?pi <testcase name="pi"/> ?>'),
  fc.constant('<!DOCTYPE x [<!ENTITY e "&e;">]>'),
  fc.string({ maxLength: 20 }),
);

test('fuzz: JUnit with entities, comments and CDATA never throws and never reads a ghost testcase out of a comment', () => {
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 24 }).map((l) => l.join('')), (xml) => {
      const out = parseJUnit(xml);
      for (const o of out) {
        assert.equal(typeof o.title, 'string');
        assert.ok(!o.title.includes('ghost') || xml.includes('<testcase name="ghost') && !xml.includes('<!--'), 'a commented-out testcase must not be parsed');
      }
    }),
    { numRuns: 400 },
  );
});

test('fuzz: decodeEntities never throws for any numeric reference', () => {
  fc.assert(
    fc.property(fc.oneof(fc.bigInt({ min: 0n, max: 2n ** 64n }), fc.nat()), fc.boolean(), (n, hex) => {
      const ref = hex ? `&#x${n.toString(16)};` : `&#${n.toString(10)};`;
      assert.doesNotThrow(() => decodeEntities(ref));
    }),
    { numRuns: 300 },
  );
});
