// Browser tests for the Team notes app, driven by okproof's own driver.
// Each test claims a criterion from .okproof/101.md by tag, in its name.
// Run by `npm run demo`, which sets DEMO_URL. Run alone, it starts the app itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../../../dist/src/driver/index.js';
import { startServer } from '../app/server.mjs';
import { addNote, browserSkipReason, errorShown, notesShown, open, refFor, waitFor } from '../lib.mjs';

const skip = browserSkipReason();
let server;
let browser;
let url = process.env.DEMO_URL;

before(async () => {
  if (skip) return;
  if (!url) {
    server = await startServer();
    url = server.url;
  }
  browser = await Browser.launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function freshPage() {
  const page = await browser.newPage();
  await open(page, url);
  return page;
}

test('[okproof:101.1] a user adds a note and sees it in the list', { skip }, async () => {
  const page = await freshPage();
  await addNote(page, 'Ship the demo');
  assert.deepEqual(await waitFor(async () => { const n = await notesShown(page); return n.length > 0 && n; }, 'the note'), ['Ship the demo']);
});

test('[okproof:101.2] a note over 140 characters shows an error and is not saved', { skip }, async () => {
  const page = await freshPage();
  await addNote(page, 'x'.repeat(141));
  assert.match(await waitFor(() => errorShown(page), 'the error message'), /too long/);
  assert.deepEqual(await notesShown(page), []);
});

test('[okproof:101.3] a user deletes a note', { skip }, async () => {
  const page = await freshPage();
  await addNote(page, 'Throw me away');
  await waitFor(async () => (await notesShown(page)).length === 1, 'the note');
  await page.click(await refFor(page, 'button', /^Delete note: Throw me away/));
  await waitFor(async () => (await notesShown(page)).length === 0, 'the note to disappear');
});

// This one fails on purpose: the app keeps notes only in memory.
test('[okproof:101.4] notes are still there after a page reload', { skip }, async () => {
  const page = await freshPage();
  await addNote(page, 'Remember the milk');
  await waitFor(async () => (await notesShown(page)).length === 1, 'the note');
  await page.reload();
  assert.deepEqual(await notesShown(page), ['Remember the milk'], 'the note should survive a reload');
});

// No test claims 101.5 (export): the feature was never built.
