import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit } from '../src/junit.js';
import { parseSnapshotRefs } from '../src/verify/actions.js';

// Inputs CodeQL flagged as slow for the old regexes. Each must parse fast.
test('JUnit attribute parsing stays linear on long runs of dashes', () => {
  const start = Date.now();
  parseJUnit(`<testcase ${'-'.repeat(50_000)} name="x"/>`);
  assert.ok(Date.now() - start < 500);
});

test('snapshot ref parsing stays linear on crafted lines', () => {
  const start = Date.now();
  parseSnapshotRefs(`- !${'!!'.repeat(50_000)}`);
  assert.ok(Date.now() - start < 500);
  assert.deepEqual(parseSnapshotRefs('- button "Save \\"now\\"" [ref=e3] [disabled]'), [{ ref: 'e3', role: 'button', name: 'Save "now"', nth: 0 }]);
});
