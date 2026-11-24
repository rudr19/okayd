import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol } from '../src/mcp/protocol.js';

function harness() {
  const out: any[] = [];
  const p = createProtocol({ write: (l) => void out.push(JSON.parse(l)), version: '9.9.9', cwd: process.cwd() });
  const send = (m: unknown) => p.handleLine(typeof m === 'string' ? m : JSON.stringify(m));
  return { out, send };
}

test('initialize echoes a supported protocol version', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(out[0].result.capabilities, { tools: {} });
  assert.deepEqual(out[0].result.serverInfo, { name: 'okproof', version: '9.9.9' });
});

test('initialize falls back to 2025-06-18 for unknown versions', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.equal(out[0].id, 'a');
});

test('ping replies with an empty result', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(out[0].result, {});
});

test('tools/list exposes the four tools with schemas', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const tools = out[0].result.tools;
  assert.deepEqual(tools.map((t: any) => t.name).sort(), ['okproof_add_criterion', 'okproof_criteria', 'okproof_ingest_junit', 'okproof_lint', 'okproof_status']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  const add = tools.find((t: any) => t.name === 'okproof_add_criterion');
  assert.deepEqual(add.inputSchema.required, ['issue', 'text']);
  assert.deepEqual(tools.find((t: any) => t.name === 'okproof_ingest_junit').inputSchema.required, ['file']);
});

test('unknown method is -32601', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 4, method: 'nope/nothing' });
  assert.equal(out[0].error.code, -32601);
  assert.equal(out[0].id, 4);
});

test('notifications get no reply, known or unknown', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await send({ jsonrpc: '2.0', method: 'something/unknown' });
  await send('');
  assert.equal(out.length, 0);
});

test('malformed JSON is -32700 with id null', async () => {
  const { out, send } = harness();
  await send('{not json');
  assert.equal(out[0].error.code, -32700);
  assert.equal(out[0].id, null);
});

test('tools/call with bad params is -32602; unknown tool too', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} });
  await send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  await send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'okproof_status', arguments: [] } });
  assert.deepEqual(out.map((o) => o.error.code), [-32602, -32602, -32602]);
});

test('a tool failure is a result with isError, not a protocol error', async () => {
  const { out, send } = harness();
  await send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'okproof_status', arguments: { issue: '../../etc' } } });
  assert.equal(out[0].error, undefined);
  assert.equal(out[0].result.isError, true);
  assert.equal(out[0].result.content[0].type, 'text');
});
