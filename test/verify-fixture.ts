// Shared by the verify tests: a tiny local app with real bugs, and skip logic.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { findChrome } from '../src/driver/index.js';
import type { Msg } from '../src/verify/model.js';

const hasWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';
export const skip = !findChrome() ? 'no Chrome found' : !hasWebSocket ? 'global WebSocket missing (needs Node 22)' : false;

export interface Fixture {
  url: string;
  close(): Promise<void>;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Routes:
 *  /       a Notes form. "Save" shows "Saved" but the server only keeps the note when `persist` is true.
 *  /flaky  says "loading" the first time it is requested and "ready" ever after.
 *  /order  two buttons whose DOM order swaps on every request.
 */
export async function startApp(opts: { persist: boolean }): Promise<Fixture> {
  let stored = '';
  let flaky = 0;
  let order = 0;
  const server: Server = createServer((req, res) => {
    const send = (body: string, type = 'text/html'): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/save' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { if (opts.persist) stored = body; res.writeHead(200); res.end('ok'); });
      return;
    }
    if (req.url === '/flaky') {
      flaky++;
      return send(`<!doctype html><title>Flaky</title><h1>Flaky</h1><p>${flaky === 1 ? 'loading' : 'ready'}</p>`);
    }
    if (req.url === '/order') {
      const buttons = ['Alpha', 'Beta'].map((n) => `<button onclick="document.getElementById('out').textContent='clicked ${n}'">${n}</button>`);
      if (order++ % 2 === 1) buttons.reverse();
      return send(`<!doctype html><title>Order</title><h1>Order</h1>${buttons.join('')}<p id="out"></p>`);
    }
    send(`<!doctype html><title>Notes</title><h1>Notes</h1>
<label>Note <input id="note" autocomplete="off"></label>
<button onclick="save()">Save</button>
<p id="status"></p>
<p>Stored note: ${esc(stored)}</p>
<script>async function save(){ await fetch('/save',{method:'POST',body:document.getElementById('note').value}); document.getElementById('status').textContent='Saved'; }</script>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Text of the most recent thing the model was shown (user text or the first tool result). */
export function lastShown(messages: Msg[]): string {
  const m = messages[messages.length - 1]!;
  if (m.role === 'user') return m.text;
  if (m.role === 'tool') return m.results.map((r) => r.text).join('\n');
  return '';
}

/** Finds the ref of an element in the latest snapshot the model saw, e.g. refOf(msgs, 'button', 'Save'). */
export function refOf(messages: Msg[], role: string, name: string): string {
  const m = new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`).exec(lastShown(messages));
  if (!m) throw new Error(`no ${role} "${name}" in:\n${lastShown(messages)}`);
  return m[1]!;
}
