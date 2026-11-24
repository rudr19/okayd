import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser, findChrome } from '../src/driver/index.js';

const chrome = findChrome();
const hasWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';
const skip = !chrome ? 'no Chrome found' : !hasWebSocket ? 'global WebSocket missing (needs Node 22)' : false;

const html = `<!doctype html><html><head><title>okproof fixture</title></head><body>
<h1>Fixture page</h1>
<a href="#x">Jump link</a>
<label>Name <input id="name" type="text"></label>
<button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value">Greet</button>
<p id="out"></p>
<input id="enter" aria-label="Enter field" onkeydown="if (event.key === 'Enter') document.getElementById('enterOut').textContent = 'enter pressed'">
<p id="enterOut"></p>
<img src="http://127.0.0.1:9/x.png" alt="missing">
<script>console.error('fixture boom');</script>
</body></html>`;

test('live driver: snapshot, type, click, press, problems, screenshot, close', { skip, timeout: 60000 }, async () => {
  const browser = await Browser.launch();
  const proc = browser.process;
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    assert.equal(await page.title(), 'okproof fixture');

    const snap = await page.snapshot();
    assert.match(snap.text, /heading "Fixture page" \[level=1\]/);
    assert.match(snap.text, /link "Jump link" \[ref=e\d+\]/);
    const refOf = (re: RegExp): string => {
      const m = re.exec(snap.text);
      assert.ok(m, `no match for ${re} in:\n${snap.text}`);
      return m[1]!;
    };
    const nameRef = refOf(/textbox "Name" \[ref=(e\d+)\]/);
    const greetRef = refOf(/button "Greet" \[ref=(e\d+)\]/);
    const enterRef = refOf(/textbox "Enter field" \[ref=(e\d+)\]/);
    assert.ok(snap.refs.size >= 4);

    await page.type(nameRef, 'okproof');
    await page.click(greetRef);
    assert.equal(await page.evaluate<string>("document.getElementById('out').textContent"), 'Hello okproof');

    await page.type(enterRef, 'x');
    await page.press('Enter');
    assert.equal(await page.evaluate<string>("document.getElementById('enterOut').textContent"), 'enter pressed');

    await assert.rejects(() => page.click('e999'), /Unknown ref e999; take a new snapshot/);
    await assert.rejects(() => page.evaluate('throw new Error("nope")'), /nope/);

    const problems = page.problems();
    assert.ok(problems.console.some((c) => c.includes('fixture boom')), JSON.stringify(problems));
    assert.ok(problems.network.length > 0, JSON.stringify(problems));

    const png = await page.screenshot();
    assert.equal(png[0], 0x89);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  } finally {
    await browser.close();
  }
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'Chrome should have exited');
});
