import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeFinding } from '../src/verify/attribution.js';
import type { Finding } from '../src/verify/detectors.js';

const base = 'http://app.test:3000';
const http = (url: string, step = 2): Finding => ({ kind: 'http-error', severity: 3, title: `HTTP 404 ${url}`, detail: `404 ${url}`, url: base, step });

test('a same-origin failed request after an action keeps its severity', () => {
  assert.equal(attributeFinding(http(`${base}/api/x`), { baseUrl: base }).severity, 3);
});

test('a third-party failed request becomes a severity 1 warning, with its title unchanged for replay matching', () => {
  const f = http('https://cdn.example.com/a.js');
  const out = attributeFinding(f, { baseUrl: base });
  assert.equal(out.severity, 1);
  assert.equal(out.downgraded, 'third-party');
  assert.equal(out.title, f.title);
});

test('a different port or scheme is a different origin', () => {
  assert.equal(attributeFinding(http('http://app.test:3001/x'), { baseUrl: base }).severity, 1);
  assert.equal(attributeFinding(http('https://app.test:3000/x'), { baseUrl: base }).severity, 1);
});

test('request-failed and console log errors name their URL too', () => {
  const failed: Finding = { kind: 'request-failed', severity: 3, title: 't', detail: 'https://t.example/p net::ERR_FAILED', url: base, step: 3 };
  assert.equal(attributeFinding(failed, { baseUrl: base }).severity, 1);
  const logged: Finding = { kind: 'console-error', severity: 3, title: 't', detail: 'log error: boom (https://t.example/p.js)', url: base, step: 3 };
  assert.equal(attributeFinding(logged, { baseUrl: base }).severity, 1);
  const own: Finding = { kind: 'console-error', severity: 3, title: 't', detail: `log error: boom (${base}/p.js)`, url: base, step: 3 };
  assert.equal(attributeFinding(own, { baseUrl: base }).severity, 3);
});

test('findings from the initial page load (step 0) cannot refute, but are kept at severity 2', () => {
  const out = attributeFinding(http(`${base}/x`, 0), { baseUrl: base });
  assert.equal(out.severity, 2);
  assert.equal(out.downgraded, 'baseline');
});

test('violations and strict mode are never downgraded', () => {
  const v: Finding = { kind: 'violation', severity: 4, title: 'v', detail: '', url: '', step: 0 };
  assert.equal(attributeFinding(v, { baseUrl: base }), v);
  const f = http('https://cdn.example.com/a.js', 0);
  assert.equal(attributeFinding(f, { baseUrl: base, strict: true }), f);
});
