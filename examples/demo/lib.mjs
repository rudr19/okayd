// Small helpers shared by the demo tests and run-demo.mjs. They sit on top of
// okproof's own driver (okproof/driver) and need a build: `npm run build`.
import { findChrome } from '../../dist/src/driver/index.js';
import { parseSnapshotRefs } from '../../dist/src/verify/index.js';

/** Why the browser steps cannot run here, or false when they can. */
export function browserSkipReason() {
  if (!findChrome()) return 'no Chrome, Chromium or Edge found (set OKPROOF_CHROME)';
  if (typeof globalThis.WebSocket !== 'function') return 'global WebSocket missing (the driver needs Node 22)';
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy, or throws after `timeoutMs`. */
export async function waitFor(fn, what, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** The ref of the first element with this role whose name matches. */
export async function refFor(page, role, name) {
  const { text } = await page.snapshot();
  const hit = parseSnapshotRefs(text).find((e) => e.role === role && (name instanceof RegExp ? name.test(e.name) : e.name === name));
  if (!hit) throw new Error(`No ${role} "${name}" on the page. Snapshot:\n${text}`);
  return hit.ref;
}

export async function open(page, url) {
  await page.setViewport(720, 420);
  await page.goto(url);
}

export async function addNote(page, text) {
  await page.type(await refFor(page, 'textbox', 'Note'), text);
  await page.click(await refFor(page, 'button', 'Add note'));
}

export const notesShown = (page) =>
  page.evaluate("Array.from(document.querySelectorAll('#list li span')).map(function (s) { return s.textContent; })");

export const errorShown = (page) => page.evaluate("document.getElementById('error').textContent");
