// Property-based tests (fast-check, a dev dependency only). Each property has a
// bounded number of runs so the suite stays fast. They check invariants on
// arbitrary input: parsers never throw anything but a plain Error, the ledger
// never calls a criterion met without a passing, non-weak test, and the lint
// scanner terminates on hostile text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseProof, claimedCriteria, type ProofFile } from '../src/proof.js';
import { parseJUnit } from '../src/junit.js';
import { parseCTRF } from '../src/ctrf.js';
import { proofFromIssue, linkedIssues } from '../src/sync.js';
import { analyzeSource, globMatch, scanBraces, stripPython } from '../src/lint.js';
import { buildLedger, isWeak, type TestOutcome } from '../src/ledger.js';

const RUNS = 150;
const cfg = { numRuns: RUNS };

/** A thrown value that is a plain, documented parse failure rather than a crash. */
const isPlainError = (e: unknown): boolean => e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError);

function neverCrashes<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    assert.ok(isPlainError(e), `unexpected ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
    return undefined;
  }
}

const anyText = fc.oneof(fc.string({ maxLength: 400 }), fc.fullUnicodeString({ maxLength: 200 }));
/** Text biased toward proof-file syntax. */
const proofish = fc
  .array(fc.oneof(fc.constant('## #12 Title'), fc.constant('- [ ] A criterion'), fc.constant('- [x] {#abc-1} Stable one'), fc.constant('{#}'), fc.constant('{#1} x'), fc.string({ maxLength: 40 })), { maxLength: 12 })
  .map((l) => l.join('\n'));

test('fuzz: parseProof returns a well-formed proof or throws a plain Error', () => {
  fc.assert(
    fc.property(fc.oneof(anyText, proofish), (s) => {
      const p = neverCrashes(() => parseProof(s));
      if (!p) return;
      assert.ok(p.criteria.length > 0);
      assert.equal(new Set(p.criteria.map((c) => c.id)).size, p.criteria.length, 'ids are unique');
      for (const c of p.criteria) assert.ok(c.id.startsWith(`${p.issue}.`));
    }),
    cfg,
  );
});

const junitish = fc
  .array(
    fc.oneof(
      fc.constant('<testsuite>'),
      fc.constant('</testsuite>'),
      fc.constant('<testcase name="a [okproof:1.1]">'),
      fc.constant('<testcase name="b" assertions="3"/>'),
      fc.constant('<failure message="x"/>'),
      fc.constant('<skipped/>'),
      fc.constant('<flakyFailure/>'),
      fc.constant('</testcase>'),
      fc.string({ maxLength: 30 }),
    ),
    { maxLength: 20 },
  )
  .map((l) => l.join(''));

test('fuzz: parseJUnit never crashes and only emits well-formed outcomes', () => {
  fc.assert(
    fc.property(fc.oneof(anyText, junitish), (s) => {
      const out = neverCrashes(() => parseJUnit(s));
      if (!out) return;
      for (const o of out) {
        assert.equal(typeof o.title, 'string');
        assert.equal(typeof o.status, 'string');
        assert.ok(o.assertions === undefined || (Number.isInteger(o.assertions) && o.assertions >= 0));
      }
    }),
    cfg,
  );
});

test('fuzz: parseCTRF never crashes on arbitrary text or JSON values', () => {
  fc.assert(
    fc.property(fc.oneof(anyText, fc.json(), fc.jsonValue().map((v) => JSON.stringify(v))), (s) => {
      const out = neverCrashes(() => parseCTRF(s));
      if (!out) return;
      for (const o of out) {
        assert.equal(typeof o.title, 'string');
        assert.equal(typeof o.status, 'string');
      }
    }),
    cfg,
  );
  fc.assert(
    fc.property(fc.jsonValue(), (v) => {
      neverCrashes(() => parseCTRF(v as object));
    }),
    cfg,
  );
});

test('fuzz: issue sync output parses back and linkedIssues returns positive integers', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 999_999 }), anyText, anyText, (issue, title, body) => {
      const md = neverCrashes(() => proofFromIssue({ issue, title, body }));
      if (md === undefined) return;
      const p = neverCrashes(() => parseProof(md));
      if (p) assert.equal(p.issue, String(issue));
    }),
    cfg,
  );
  fc.assert(
    fc.property(fc.oneof(anyText, fc.array(fc.oneof(fc.constant('Closes #12 '), fc.constant('fixes #3,'), fc.constant('#'), fc.string({ maxLength: 10 }))).map((l) => l.join(''))), (s) => {
      const ids = linkedIssues(s);
      assert.equal(new Set(ids).size, ids.length);
      for (const n of ids) assert.ok(Number.isInteger(n) && n > 0);
    }),
    cfg,
  );
});

const codeish = fc
  .array(fc.oneof(fc.constant('('), fc.constant('/'), fc.constant('['), fc.constant('`'), fc.constant('"'), fc.constant("'"), fc.constant('//'), fc.constant('/*'), fc.constant('\n'), fc.constant('\\'), fc.constant('return '), fc.constant("test('x [okproof:1.1]', () => {"), fc.constant('expect(1).toBe(2)'), fc.string({ maxLength: 6 })), { maxLength: 60 })
  .map((l) => l.join(''));

test('fuzz: lint scanners terminate and stay within their bounds on arbitrary code', () => {
  fc.assert(
    fc.property(fc.oneof(anyText, codeish), fc.boolean(), (s, python) => {
      const r = analyzeSource(s, python);
      for (const t of r.tests) assert.ok(t.ids.length > 0);
      const sc = scanBraces(s, 0, 0);
      assert.ok(sc.end <= s.length);
      assert.ok(sc.code.length <= s.length + sc.lits.length + 64);
      assert.equal(typeof stripPython(s), 'string');
    }),
    cfg,
  );
});

test('fuzz: globMatch is total and agrees with literal equality when there is no wildcard', () => {
  fc.assert(
    fc.property(fc.stringOf(fc.constantFrom('a', 'b', '/', '*', '?', '.'), { maxLength: 40 }), fc.stringOf(fc.constantFrom('a', 'b', '/', '.'), { maxLength: 40 }), (g, p) => {
      const r = globMatch(g, p);
      assert.equal(typeof r, 'boolean');
      if (!/[*?]/.test(g)) assert.equal(r, g === p);
      assert.equal(globMatch(p, p), true);
    }),
    cfg,
  );
});

const verdictTitle = fc.constantFrom('t one [okproof:7.1]', 't two [okproof:7.2]', 't both [okproof:7.1] [okproof:7.2]', 'untagged', 't other [okproof:9.1]');
const outcome: fc.Arbitrary<TestOutcome> = fc.record(
  {
    title: fc.oneof(verdictTitle, fc.string({ maxLength: 20 })),
    status: fc.constantFrom('passed', 'failed', 'flaky', 'skipped', 'timed-out'),
    assertions: fc.option(fc.nat({ max: 5 }), { nil: undefined }),
  },
  { requiredKeys: ['title', 'status'] },
);
const proof: ProofFile = {
  issue: '7',
  title: 'P',
  criteria: [
    { id: '7.1', issue: '7', index: 1, text: 'one' },
    { id: '7.2', issue: '7', index: 2, text: 'two' },
  ],
};

test('fuzz: ledger invariants (met needs a passing non-weak test, failures win, proven means all met)', () => {
  fc.assert(
    fc.property(fc.array(outcome, { maxLength: 12 }), fc.boolean(), (outcomes, strict) => {
      const l = buildLedger(proof, outcomes, { strictAssertions: strict });
      assert.equal(l.entries.length, proof.criteria.length);
      assert.equal(l.proven, l.entries.every((e) => e.verdict === 'met'));
      for (const e of l.entries) {
        const claiming = outcomes.filter((o) => claimedCriteria(o.title).includes(e.id));
        if (e.verdict === 'untested') assert.equal(claiming.length, 0);
        else assert.equal(e.tests.length, claiming.length);
        if (e.verdict === 'met') {
          assert.ok(claiming.length > 0);
          assert.ok(claiming.every((o) => o.status === 'passed'));
          assert.ok(claiming.some((o) => !isWeak(o, strict)));
        }
        if (claiming.some((o) => o.status !== 'passed')) assert.equal(e.verdict, 'failed');
        if (e.verdict === 'unproven') assert.ok(claiming.every((o) => o.status === 'passed' && isWeak(o, strict)));
      }
    }),
    cfg,
  );
});
