import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

test('okproof mcp speaks MCP over stdio', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'okproof-e2e-'));
  await mkdir(join(cwd, '.okproof'));
  await writeFile(join(cwd, '.okproof', '5.md'), '## #5 Demo\n- [ ] It works\n');

  const child = spawn(process.execPath, [cli, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'okproof_status', arguments: {} } }) + '\n');
  child.stdin.end();

  const code = await done;
  assert.equal(code, 0);
  const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'initialize and tools/call reply; the notification does not');
  assert.equal(lines[0].result.serverInfo.name, 'okproof');
  assert.equal(lines[1].id, 2);
  assert.match(lines[1].result.content[0].text, /^Not done: 0 of 1 criteria proven\./);
  await rm(cwd, { recursive: true, force: true });
});
