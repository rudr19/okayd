import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsLiteral } from '../src/verify/auth.js';

test('jsLiteral escapes script-breaking characters and round-trips', () => {
  const v = ['</script><b>&x', 'a b c', "q'\"\\"];
  const out = jsLiteral(v);
  assert.ok(!/[<>&  ]/.test(out) && !out.includes('</'));
  assert.deepEqual(eval(out), v);
});
