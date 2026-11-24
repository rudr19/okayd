import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/driver/index.js';
import { replay } from '../src/verify/replay.js';
import type { Action } from '../src/verify/actions.js';
import { skip, startApp } from './verify-fixture.js';

test('replay resolves click targets by role and name after the DOM changes order', { skip, timeout: 60000 }, async () => {
  const app = await startApp({ persist: false });
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    // Recorded when Alpha was the first button (ref e1). /order swaps the order on every request,
    // so on replay Alpha is e2 and a stale ref would click Beta.
    const actions: Action[] = [
      { type: 'goto', url: '/order' },
      { type: 'click', ref: 'e1', role: 'button', name: 'Alpha', nth: 0 },
      { type: 'assertText', text: 'clicked Alpha', present: true },
    ];
    for (let round = 0; round < 2; round++) {
      const r = await replay(actions, await browser.newPage(), { baseUrl: app.url });
      assert.equal(r.abortedAt, undefined, r.abortReason);
      assert.equal(r.assertionFailed.get(2), false, `round ${round}: Alpha should have been clicked`);
    }
    void page;
  } finally {
    await browser.close();
    await app.close();
  }
});

test('replay stops at an element that is gone and reports why', { skip, timeout: 60000 }, async () => {
  const app = await startApp({ persist: false });
  const browser = await Browser.launch();
  try {
    const r = await replay(
      [
        { type: 'goto', url: '/order' },
        { type: 'click', role: 'button', name: 'Gamma', nth: 0 },
        { type: 'assertText', text: 'anything', present: true },
      ],
      await browser.newPage(),
      { baseUrl: app.url },
    );
    assert.equal(r.abortedAt, 1);
    assert.match(r.abortReason ?? '', /No button "Gamma"/);
    assert.equal(r.assertionFailed.has(2), false, 'the assertion never ran, so it cannot confirm anything');
  } finally {
    await browser.close();
    await app.close();
  }
});
