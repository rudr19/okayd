import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsLiteral } from '../src/verify/auth.js';

test('jsLiteral escapes script-breaking characters and round-trips', () => {
  const v = ['</script><b>&x', 'a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x2029) + 'c', 'quote"and\\backslash'];
  const out = jsLiteral(v);
  for (const ch of ['<', '>', '&', '/', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) assert.ok(!out.includes(ch), ch);
  assert.deepEqual(JSON.parse(out), v);
});
