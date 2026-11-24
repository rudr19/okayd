// "Team notes": a tiny web app with no dependencies, served by node:http.
// It has one deliberate bug (notes live only in the page, so a reload loses
// them) and one feature nobody built (export).
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MAX_LENGTH = 140;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Team notes</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.5rem; margin-bottom: 1rem; }
  form { display: flex; gap: .5rem; align-items: center; }
  input { flex: 1; padding: .45rem .6rem; font: inherit; border: 1px solid #8b949e; border-radius: 6px; }
  button { padding: .45rem .8rem; font: inherit; border: 1px solid #1f6feb; background: #1f6feb; color: #fff; border-radius: 6px; cursor: pointer; }
  #error { color: #b42318; min-height: 1.5rem; margin: .5rem 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; gap: 1rem; padding: .55rem .2rem; border-bottom: 1px solid #d0d7de; }
  li button { background: #fff; color: #b42318; border-color: #d0d7de; }
  #empty { color: #57606a; }
</style>
</head>
<body>
<h1>Team notes</h1>
<form id="form">
  <label for="note">Note</label>
  <input id="note" autocomplete="off">
  <button type="submit">Add note</button>
</form>
<p id="error" role="alert"></p>
<ul id="list"></ul>
<p id="empty">No notes yet.</p>
<script>
  var MAX = ${MAX_LENGTH};
  // BUG: notes are kept only in this array, in memory, for this page load.
  // Nothing is saved anywhere, so a reload starts from an empty list.
  var notes = [];
  var list = document.getElementById('list');
  var empty = document.getElementById('empty');
  var error = document.getElementById('error');
  var input = document.getElementById('note');

  function render() {
    list.textContent = '';
    notes.forEach(function (text, i) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = text;
      var del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', 'Delete note: ' + text.slice(0, 40));
      del.onclick = function () { notes.splice(i, 1); render(); };
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    });
    empty.hidden = notes.length > 0;
  }

  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    if (text.length > MAX) {
      error.textContent = 'Note is too long: ' + text.length + ' characters, the limit is ' + MAX + '.';
      return;
    }
    error.textContent = '';
    notes.push(text);
    input.value = '';
    render();
  };
  render();
</script>
</body>
</html>
`;

/** Starts the app. Port 0 picks a free port. Resolves to { url, close }. */
export function startServer({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
    } else if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`Team notes running at ${url}`);
}
