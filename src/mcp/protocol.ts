// Newline-delimited JSON-RPC 2.0 for MCP, independent of any transport:
// feed it lines, it calls `write` with reply lines (no trailing newline).
import { runTool, tools as defaultTools, type ToolDefinition } from './tools.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = '2025-06-18';

export interface ProtocolOptions {
  write: (line: string) => void | Promise<void>;
  cwd?: string;
  version?: string;
  tools?: ToolDefinition[];
  log?: (message: string) => void;
}

type Id = string | number | null;

export interface Protocol {
  /** Handle one input line. Resolves once any reply has been written. */
  handleLine(line: string): Promise<void>;
}

export function createProtocol(options: ProtocolOptions): Protocol {
  const tools = options.tools ?? defaultTools;
  const cwd = options.cwd ?? process.cwd();
  const version = options.version ?? '0.0.0';
  const log = options.log ?? (() => {});

  const send = async (msg: object) => {
    await options.write(JSON.stringify(msg));
  };
  const reply = (id: Id, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handleRequest(id: Id, method: string, params: unknown): Promise<void> {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : undefined;
    switch (method) {
      case 'initialize': {
        const asked = p?.protocolVersion;
        return reply(id, {
          protocolVersion: typeof asked === 'string' && SUPPORTED.includes(asked) ? asked : LATEST,
          capabilities: { tools: {} },
          serverInfo: { name: 'okayd', version },
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        if (!p || typeof p.name !== 'string') return fail(id, -32602, 'tools/call needs params.name (string).');
        const tool = tools.find((t) => t.name === p.name);
        if (!tool) return fail(id, -32602, `Unknown tool "${p.name}". Available: ${tools.map((t) => t.name).join(', ')}.`);
        const args = p.arguments ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          return fail(id, -32602, 'params.arguments must be an object.');
        }
        return reply(id, await runTool(tool, args as Record<string, unknown>, { cwd }));
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    async handleLine(line) {
      const text = line.trim();
      if (text === '') return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return fail(null, -32700, 'Parse error: each line must be one JSON object.');
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
        return fail(null, -32600, 'Invalid Request: expected a single JSON-RPC object (batches are not supported).');
      }
      const m = msg as Record<string, unknown>;
      const hasId = 'id' in m && m.id !== undefined;
      if (typeof m.method !== 'string') {
        if ('result' in m || 'error' in m) return; // a response to something we never sent
        if (hasId) return fail(m.id as Id, -32600, 'Invalid Request: "method" must be a string.');
        return;
      }
      if (!hasId) {
        log(`notification ${m.method}`);
        return; // notifications never get a reply, known or not
      }
      const id = m.id;
      if (typeof id !== 'string' && typeof id !== 'number') return fail(null, -32600, 'Invalid Request: "id" must be a string or number.');
      try {
        await handleRequest(id, m.method, m.params);
      } catch (e) {
        log(`internal error: ${(e as Error).stack ?? e}`);
        await fail(id, -32603, `Internal error: ${(e as Error).message}`);
      }
    },
  };
}
