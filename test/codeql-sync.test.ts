import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCriteria, linkedIssues } from '../src/sync.js';
import { renderLedgerMarkdown } from '../src/ledger.js';

test('issue parsing stays fast on hostile lines', () => {
  const start = Date.now();
  issueCriteria(`- [ ] x${' '.repeat(60_000)}y\n## T${' \t'.repeat(30_000)}#\n## ${'#'.repeat(60_000)}`);
  assert.ok(Date.now() - start < 500);
  assert.deepEqual(issueCriteria('## Acceptance criteria ##\n- [ ] Saves   \n* [x] Loads'), ['Saves', 'Loads']);
});

test('HTML comments are fully stripped before reading closing keywords', () => {
  assert.deepEqual(linkedIssues('<!-<!-- x -->- Closes #9 -->\nFixes #3'), [3]);
  assert.deepEqual(linkedIssues('Closes #4 <!-- unterminated Closes #5'), [4]);
});

test('ledger escapes backslashes before pipes', () => {
  const md = renderLedgerMarkdown({ issue: '1', title: 't', proven: false, entries: [{ id: '1.1', text: 'a\|b', verdict: 'untested', tests: [] }] } as any);
  assert.match(md, /a\\\\|b/);
});
