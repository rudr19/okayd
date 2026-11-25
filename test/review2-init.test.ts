// Independent review, round 2: init prints how to tag a test for the chosen runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNNERS, runInit, tagExample } from '../src/init.js';
import { claimedCriteria } from '../src/proof.js';
import { analyzeSource } from '../src/lint.js';

test('every runner has a tag example whose reported test name claims the criterion', () => {
  for (const runner of RUNNERS) {
    const ex = tagExample(runner, '1.1');
    assert.deepEqual(claimedCriteria(ex.reportedName), ['1.1'], runner);
    assert.ok(ex.snippet.includes('[okproof:1.1]'), runner);
  }
});

test('the pytest example is found by lint as a tagged test', () => {
  const src = `${tagExample('pytest', '1.1').snippet.replace('assert ...', 'assert total == 3')}\n`;
  const found = analyzeSource(src, true).tests;
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.ids, ['1.1']);
  assert.equal(found[0]!.weak, false);
});

test('init prints the runner-specific example in its next steps', async () => {
  for (const runner of RUNNERS) {
    const cwd = await mkdtemp(join(tmpdir(), 'okp-init2-'));
    const r = await runInit({ cwd, runner });
    const text = r.lines.join('\n');
    assert.ok(text.includes(`(${runner})`), runner);
    assert.ok(text.includes('[okproof:1.1]'), runner);
    assert.match(text, /replace|Edit .okproof/i);
  }
});
