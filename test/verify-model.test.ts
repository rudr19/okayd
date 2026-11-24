import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicModel, MISSING_KEY_MESSAGE, ScriptedModel, parseAnthropicResponse } from '../src/verify/model.js';
import { TOOLS } from '../src/verify/agent.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('AnthropicModel needs an explicit key and never reads ANTHROPIC_API_KEY', () => {
  withEnv({ OKAYD_ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY: 'dummy-not-a-real-key', ANTHROPIC_AUTH_TOKEN: 'dummy-token' }, () => {
    assert.throws(() => new AnthropicModel(), (e: Error) => e.message === MISSING_KEY_MESSAGE && /OKAYD_ANTHROPIC_API_KEY/.test(e.message));
    assert.throws(() => new AnthropicModel({ model: 'claude-opus-5-5' }), /OKAYD_ANTHROPIC_API_KEY/);
  });
});

test('AnthropicModel accepts a key from the option or OKAYD_ANTHROPIC_API_KEY (no SDK is loaded)', () => {
  withEnv({ OKAYD_ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => {
    assert.doesNotThrow(() => new AnthropicModel({ apiKey: 'explicit' }));
  });
  withEnv({ OKAYD_ANTHROPIC_API_KEY: 'from-env' }, () => {
    assert.doesNotThrow(() => new AnthropicModel());
  });
});

test('AnthropicModel builds the request the API expects and parses the response (fake client)', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = {
    messages: {
      async create(params: Record<string, unknown>) {
        sent.push(params);
        return {
          content: [
            { type: 'thinking', thinking: '...' },
            { type: 'text', text: 'trying a reload' },
            { type: 'tool_use', id: 'toolu_1', name: 'reload', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
  const model = new AnthropicModel({ client });
  const res = await model.next({
    system: 'SYS',
    tools: TOOLS,
    messages: [
      { role: 'user', text: 'go' },
      { role: 'assistant', toolCalls: [{ id: 'toolu_0', name: 'snapshot', input: {} }], raw: [{ type: 'tool_use', id: 'toolu_0', name: 'snapshot', input: {} }] },
      { role: 'tool', results: [{ id: 'toolu_0', text: 'ok', imageBase64: 'QUJD' }] },
    ],
  });
  const req = sent[0]!;
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.tool_choice, { type: 'auto' });
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.deepEqual(req.cache_control, { type: 'ephemeral' });
  assert.equal('thinking' in req, false, 'adaptive thinking: thinking is omitted');
  const tools = req.tools as { strict: boolean; input_schema: { additionalProperties: boolean } }[];
  assert.ok(tools.length === TOOLS.length && tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  const msgs = req.messages as { role: string; content: unknown }[];
  assert.deepEqual(msgs[1], { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'snapshot', input: {} }] });
  assert.deepEqual((msgs[2]!.content as { content: unknown }[])[0], {
    type: 'tool_result',
    tool_use_id: 'toolu_0',
    content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }],
  });
  assert.equal(res.stop, 'tool_use');
  assert.deepEqual(res.toolCalls, [{ id: 'toolu_1', name: 'reload', input: {} }]);
  assert.deepEqual(res.usage, { input: 10, output: 5 });
});

test('parseAnthropicResponse treats refusal and max_tokens as clean stops and drops their tool calls', () => {
  const content = [{ type: 'tool_use', id: 't', name: 'click', input: { ref: 'e1' } }];
  assert.deepEqual(parseAnthropicResponse({ content, stop_reason: 'refusal' }).toolCalls, []);
  assert.equal(parseAnthropicResponse({ content, stop_reason: 'refusal' }).stop, 'refusal');
  assert.equal(parseAnthropicResponse({ content, stop_reason: 'max_tokens' }).stop, 'max_tokens');
  assert.equal(parseAnthropicResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }).stop, 'end');
});

test('every tool schema is strict-compatible', () => {
  for (const t of TOOLS) {
    const s = t.inputSchema as { type: string; properties: object; required: string[]; additionalProperties: boolean };
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false, t.name);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${t.name}: strict tools need every property required`);
  }
});

test('ScriptedModel returns queued responses and errors when empty', async () => {
  const m = new ScriptedModel([{ toolCalls: [{ name: 'reload', input: {} }] }, { text: 'bye' }]);
  const req = { system: '', messages: [], tools: [] };
  const a = await m.next(req);
  assert.equal(a.stop, 'tool_use');
  assert.equal(a.toolCalls[0]!.id, 'call_1');
  assert.equal((await m.next(req)).stop, 'end');
  await assert.rejects(() => m.next(req), /ran out/);
});
