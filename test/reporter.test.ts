import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { okayd } from '../src/index.js';

// Event shapes copied from a real e2e 0.24 run against a live site.
function finished(title: string, status: string, id: string) {
  return {
    type: 'test-finished',
    result: {
      test: { id: `tests/x.e2e.ts::${id}`, title },
      status,
      attempts: [{ id: `attempt-${id}`, durationMs: 13194, environment: { browser: 'chromium 159' } }],
    },
  };
}

test('returns label/text summary rows and writes the ledger with evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'okayd-'));
  await writeFile(join(dir, '900.md'), '## #900 Home\n- [ ] Heading\n- [ ] Skip link\n- [ ] Ask panel\n');
  const r = okayd({ dir, github: false });
  r.onEvent(finished('heading [okayd:900.1]', 'passed', 'a'));
  r.onEvent(finished('skip [okayd:900.2]', 'failed', 'b'));
  const rows = await r.onRunFinished({ traces: new Map([['attempt-b', 'results/b/trace.md']]) });

  assert.deepEqual(rows, [{ label: 'okayd #900', text: '1/3 criteria met, not proven' }]);
  const ledger = JSON.parse(await readFile(join(dir, 'ledger-900.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((e: { verdict: string }) => e.verdict), ['met', 'failed', 'untested']);
  assert.equal(ledger.entries[0].tests[0].evidence, 'passed in 13.2s on chromium 159');
  assert.equal(ledger.entries[1].tests[0].evidence, 'results/b/trace.md');
});
