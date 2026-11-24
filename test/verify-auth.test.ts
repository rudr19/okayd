// Audit gap 7: the verifier can only test what it can reach. It needs a way to
// be signed in (storage state, cookies, headers, a login hook) without ever
// printing or saving the secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptedModel, type ScriptedStep } from '../src/verify/model.js';
import { verify, type VerifyOptions } from '../src/verify/run.js';
import { parseHeader } from '../src/verify/auth.js';
import { lastShown, skip } from './verify-fixture.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const COOKIE = 's3cretCookieValue';
const TOKEN = 'tok3nHeaderValue';

/** An app that only greets you when you are signed in by cookie or header. */
async function startAuthApp(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const cookie = String(req.headers.cookie ?? '');
    const ok = cookie.split(/;\s*/).includes(`sid=${COOKIE}`) || req.headers['x-okproof-token'] === TOKEN;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      ok
        ? '<!doctype html><title>App</title><h1>Welcome back</h1><p id="t"></p><script>document.getElementById("t").textContent="theme=" + (localStorage.getItem("theme") || "none")</script>'
        : '<!doctype html><title>App</title><h1>Please log in</h1>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const stop = (s: Server): Promise<void> => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });

const conclude: ScriptedStep = { toolCalls: [{ name: 'conclude', input: { holds: true, summary: 'ok' } }] };

/** What the model was first shown (the page after the verifier's first navigation). */
async function seen(extra: (origin: string, dir: string) => Promise<Record<string, unknown>>): Promise<{ page: string; dir: string; log: string[] }> {
  const { server, origin } = await startAuthApp();
  const dir = await mkdtemp(join(tmpdir(), 'okproof-auth-'));
  await writeFile(join(dir, '7.md'), '## #7 App\n- [ ] Signed-in users see a greeting\n');
  const log: string[] = [];
  try {
    const model = new ScriptedModel([conclude]);
    await verify({ dir, baseUrl: origin, model, maxSteps: 3, log: (l) => log.push(l), ...(await extra(origin, dir)) } as VerifyOptions);
    return { page: lastShown(model.requests[0]!.messages), dir, log };
  } finally {
    await stop(server);
  }
}

test('control: without auth the verifier sees the logged-out page', { skip, timeout: 120000 }, async () => {
  const r = await seen(async () => ({}));
  try {
    assert.match(r.page, /Please log in/);
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test('storageState: cookies and localStorage from a Playwright-shaped file are applied', { skip, timeout: 120000 }, async () => {
  const r = await seen(async (origin, dir) => {
    const file = join(dir, 'auth.json');
    await writeFile(
      file,
      JSON.stringify({
        cookies: [{ name: 'sid', value: COOKIE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
        origins: [{ origin, localStorage: [{ name: 'theme', value: 'dark' }] }],
      }),
    );
    return { storageState: file };
  });
  try {
    assert.match(r.page, /Welcome back/);
    assert.match(r.page, /theme=dark/);
    const everything = [r.log.join('\n'), ...(await Promise.all((await readdir(r.dir)).filter((n) => n.endsWith('.json') && n !== 'auth.json').map((n) => readFile(join(r.dir, n), 'utf8'))))].join('\n');
    assert.ok(!everything.includes(COOKIE), 'cookie value leaked into logs or evidence');
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test('cookies option: name and value only, scoped to the base URL', { skip, timeout: 120000 }, async () => {
  const r = await seen(async () => ({ cookies: [{ name: 'sid', value: COOKIE }] }));
  try {
    assert.match(r.page, /Welcome back/);
    assert.ok(!r.log.join('\n').includes(COOKIE));
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test('headers option: extra HTTP headers are sent and their values are never logged', { skip, timeout: 120000 }, async () => {
  const r = await seen(async () => ({ headers: { 'X-Okproof-Token': TOKEN } }));
  try {
    assert.match(r.page, /Welcome back/);
    assert.ok(!r.log.join('\n').includes(TOKEN));
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test('login hook: a module default export runs against the page before the criterion', { skip, timeout: 120000 }, async () => {
  const r = await seen(async (origin, dir) => {
    const file = join(dir, 'login.mjs');
    await writeFile(
      file,
      `export default async (page) => {
  await page.goto(${JSON.stringify(origin + '/')});
  await page.evaluate(${JSON.stringify(`document.cookie = 'sid=${COOKIE}; path=/'`)});
};
`,
    );
    return { login: file };
  });
  try {
    assert.match(r.page, /Welcome back/);
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test('the replay that confirms a finding is signed in too', { skip, timeout: 120000 }, async () => {
  const { server, origin } = await startAuthApp();
  const dir = await mkdtemp(join(tmpdir(), 'okproof-auth-'));
  await writeFile(join(dir, '7.md'), '## #7 App\n- [ ] Signed-in users see a greeting\n');
  try {
    // Claims the greeting should be absent. That fails live only because the page is signed in,
    // and it can only be confirmed if the fresh replay browser is signed in as well.
    const model = new ScriptedModel([
      { toolCalls: [{ name: 'report_violation', input: { title: 'Greeting shown', expected: 'no greeting', actual: 'Welcome back is shown' } }] },
      { toolCalls: [{ name: 'assert_text', input: { text: 'Welcome back', present: false } }] },
      conclude,
    ]);
    const runs = await verify({ dir, baseUrl: origin, model, maxSteps: 6, cookies: [{ name: 'sid', value: COOKIE }] } as VerifyOptions);
    const violation = runs[0]!.results[0]!.findings.find((f) => f.kind === 'violation');
    assert.equal(violation?.confirmed, true);
  } finally {
    await stop(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseHeader accepts "Name: value" and rejects anything else without echoing the value', () => {
  assert.deepEqual(parseHeader('X-Test: a: b'), ['X-Test', 'a: b']);
  assert.deepEqual(parseHeader('Authorization:Bearer x'), ['Authorization', 'Bearer x']);
  for (const bad of ['nocolon', ': v', 'Bad Name: v', 'X: a\r\nInjected: 1']) {
    assert.throws(() => parseHeader(bad), (e: Error) => /--header must look like/.test(e.message) && !e.message.includes('Injected') && !e.message.includes('nocolon'));
  }
});

function okproof(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [cli, 'verify', '--url', 'http://127.0.0.1:9', ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('CLI: bad auth flags exit 2 with a message that does not repeat the secret', async () => {
  const bad = okproof(['--header', 'no-colon-secret-abc']);
  assert.equal(bad.status, 2);
  assert.match(bad.out, /--header must look like/);
  assert.ok(!bad.out.includes('no-colon-secret-abc'));

  const dir = await mkdtemp(join(tmpdir(), 'okproof-auth-'));
  try {
    const missing = okproof(['--storage-state', join(dir, 'nope.json')]);
    assert.equal(missing.status, 2);
    assert.match(missing.out, /storage state file .*nope\.json could not be read/);

    await writeFile(join(dir, 'broken.json'), '{"cookies": [{"name":"sid","value":"leaky-secret-xyz"');
    const broken = okproof(['--storage-state', join(dir, 'broken.json')]);
    assert.equal(broken.status, 2);
    assert.match(broken.out, /is not valid JSON/);
    assert.ok(!broken.out.includes('leaky-secret-xyz'));

    const login = okproof(['--login', join(dir, 'missing.mjs')]);
    assert.equal(login.status, 2);
    assert.match(login.out, /login script .*missing\.mjs could not be loaded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
