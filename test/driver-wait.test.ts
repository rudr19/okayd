import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Browser } from '../src/driver/index.js';
import { skip } from './verify-fixture.js';

/** A page with an image the server never answers. */
async function hangingImageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const hung: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === '/slow.png') { hung.push(res); return; } // never respond
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Slow image</title><h1>Hello</h1><img src="/slow.png" alt="slow"><p id="s">ready</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => { for (const h of hung) h.destroy(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

test('goto: a resource that never finishes times out with an actionable error on load', { skip, timeout: 60000 }, async () => {
  const app = await hangingImageServer();
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    await assert.rejects(
      () => page.goto(app.url, { timeoutMs: 1500 }),
      (e: Error) => {
        assert.match(e.message, /Page did not finish loading within 1\.5s \(waited for the load event\)/);
        assert.match(e.message, /try waitUntil: 'domcontentloaded' or a larger timeoutMs/);
        return true;
      },
    );
  } finally {
    await browser.close();
    await app.close();
  }
});

test('goto: domcontentloaded returns while the image is still pending', { skip, timeout: 60000 }, async () => {
  const app = await hangingImageServer();
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.goto(app.url, { timeoutMs: 10000, waitUntil: 'domcontentloaded' });
    assert.ok(Date.now() - t0 < 8000);
    assert.equal(await page.title(), 'Slow image');
    assert.equal(await page.evaluate<string>("document.getElementById('s').textContent"), 'ready');
  } finally {
    await browser.close();
    await app.close();
  }
});

test('goto: networkidle never settles while a request hangs, and names what it waited for', { skip, timeout: 60000 }, async () => {
  const app = await hangingImageServer();
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    await assert.rejects(
      () => page.goto(app.url, { timeoutMs: 1500, waitUntil: 'networkidle' }),
      /Page did not finish loading within 1\.5s \(waited for (the load event|network idle)/,
    );
  } finally {
    await browser.close();
    await app.close();
  }
});

test('goto: networkidle waits for quiet, load stays the default, and the browser-wide default applies', { skip, timeout: 60000 }, async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/late') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('late'); }, 800); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Idle</title><p id="o">waiting</p><script>addEventListener("load",function(){ setTimeout(function(){ fetch("/late").then(function(r){return r.text()}).then(function(t){document.getElementById("o").textContent=t}) },100) })</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await Browser.launch({ waitUntil: 'networkidle' });
  try {
    const page = await browser.newPage();
    assert.equal(page.waitUntil, 'networkidle');
    await page.goto(url);
    assert.equal(await page.evaluate<string>("document.getElementById('o').textContent"), 'late', 'networkidle should wait for the late fetch');
    await page.goto(url, { waitUntil: 'load' });
    assert.equal(await page.evaluate<string>("document.getElementById('o').textContent"), 'waiting', 'an explicit load returns before the fetch');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
