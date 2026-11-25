// A small notes app for the probe tests. Clean by default; each flag switches one real bug on.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Bugs {
  /** Says "Saved" but the server forgets the note. */
  lose?: boolean;
  /** The submit button can be clicked twice and each click is sent. */
  dup?: boolean;
  /** A 640px-wide banner, so a phone scrolls sideways. */
  overflow?: boolean;
  /** "Buy now" is a div with an onclick: Tab never reaches it. */
  unreachable?: boolean;
  /** Focus outlines removed, nothing in their place. */
  noFocus?: boolean;
  /** Notes are put into the page as HTML. */
  xss?: boolean;
  /** Fetch failures are not caught: an uncaught promise rejection offline. */
  crashOffline?: boolean;
  /** Fetch failures wipe the page. */
  blankOffline?: boolean;
  /** A client-side link that pushes history but never restores on Back. */
  backBug?: boolean;
  /** The server answers 500 to long notes. */
  error500?: boolean;
  /** A "Pay now" button that collapses to nothing on a phone. */
  collapse?: boolean;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface ProbeApp {
  url: string;
  items: string[];
  posts: number;
  close(): Promise<void>;
}

export async function startProbeApp(bugs: Bugs = {}): Promise<ProbeApp> {
  const items: string[] = [];
  const app = { posts: 0 };
  const server: Server = createServer((req, res) => {
    const send = (body: string, status = 200, type = 'text/html'): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/save' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        app.posts++;
        if (bugs.error500 && body.length > 5000) return send('boom', 500, 'text/plain');
        if (!bugs.lose) items.push(body);
        send('ok', 200, 'text/plain');
      });
      return;
    }
    if (req.url === '/items.json') return send(JSON.stringify(items), 200, 'application/json');
    if (req.url === '/about') return send('<!doctype html><title>About</title><h1>About</h1><p>Plain page.</p><a href="/">Home</a>');
    const li = (i: string): string => `<li>${bugs.xss ? i : esc(i)}</li>`;
    const css = `body{font-family:sans-serif;margin:16px}li{overflow-wrap:anywhere}input{max-width:100%}${bugs.noFocus ? 'button,input,a{outline:none}' : ''}${bugs.collapse ? '@media (max-width:400px){#pay{width:0;height:0;padding:0;border:0;overflow:hidden}}' : ''}`;
    const addLi = bugs.xss ? 'li.innerHTML=v' : 'li.textContent=v';
    const offlineHandler = bugs.blankOffline ? "document.body.innerHTML=''" : "status.textContent='You appear to be offline'";
    const guard = (expr: string): string => (bugs.crashOffline ? expr : `${expr}.catch(function(){ ${offlineHandler} })`);
    send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notes</title><style>${css}</style></head><body>
<h1>Notes</h1>
<nav><a href="/about">About</a>${bugs.backBug ? ' <a href="/settings" id="settings">Settings</a>' : ''}</nav>
${bugs.overflow ? '<div style="width:640px;background:#eee">A wide banner</div>' : ''}
<form id="f"><label>Note <input id="note" autocomplete="off"></label> <button type="submit" id="save">Save</button></form>
<button type="button" id="refresh">Refresh</button>
${bugs.collapse ? '<button type="button" id="pay">Pay now</button>' : ''}
${bugs.unreachable ? '<div role="button" onclick="document.getElementById(\'status\').textContent=\'Bought\'">Buy now</div>' : '<button type="button" onclick="document.getElementById(\'status\').textContent=\'Bought\'">Buy now</button>'}
<p id="status"></p>
<ul id="items">${items.map(li).join('')}</ul>
<script>
var status=document.getElementById('status'), input=document.getElementById('note'), btn=document.getElementById('save'), list=document.getElementById('items'), busy=false;
function render(arr){ list.innerHTML=''; arr.forEach(function(v){ var li=document.createElement('li'); ${addLi}; list.appendChild(li) }) }
async function send(v){
  var r=await fetch('/save',{method:'POST',body:v});
  status.textContent='Saved';
  var li=document.createElement('li'); ${addLi}; list.appendChild(li);
}
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  ${bugs.dup ? '' : 'if(busy) return; busy=true; btn.disabled=true;'}
  var v=input.value;
  ${guard('send(v)')}${bugs.dup ? ';' : '.finally(function(){ busy=false; btn.disabled=false; input.value=\'\' });'}
});
document.getElementById('refresh').addEventListener('click',function(){ ${guard("fetch('/items.json').then(function(r){return r.json()}).then(render)")} });
${bugs.backBug ? `document.getElementById('settings').addEventListener('click',function(e){ e.preventDefault(); history.pushState({}, '', '/settings'); document.body.innerHTML='<h1>Settings</h1><p>Preferences</p>'; });` : ''}
</script></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    items,
    get posts() { return app.posts; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A clean page that uses patterns a naive check would flag: none of this is a bug. */
export async function startAwkwardApp(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Awkward</title><style>
body{font-family:sans-serif;margin:16px}
.skip{position:absolute;left:-9999px;top:0}.skip:focus{left:8px;top:8px;background:#fff;outline:2px solid #00f}
nav#menu{position:fixed;top:0;left:0;width:240px;transform:translateX(0);background:#eee}
@media (max-width:400px){nav#menu{transform:translateX(-100%)}}
main{margin-left:260px}@media (max-width:400px){main{margin-left:0}}
button.bg{outline:none;background:#eee;border:0;padding:6px}button.bg:focus{background:#9cf}
button.sh{outline:none}button.sh:focus{box-shadow:0 0 0 3px #00f}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<nav id="menu"><a href="/about">About us</a> <button type="button">Menu item</button></nav>
<main id="main"><h1>Awkward but fine</h1>
<div role="tablist"><button role="tab" tabindex="0" aria-selected="true">One</button><button role="tab" tabindex="-1" aria-selected="false">Two</button></div>
<fieldset><legend>Size</legend><label><input type="radio" name="size" value="s"> Small</label> <label><input type="radio" name="size" value="m"> Medium</label></fieldset>
<button type="button" class="bg">Background focus</button> <button type="button" class="sh">Shadow focus</button>
<input aria-label="Search" type="text">
</main></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
