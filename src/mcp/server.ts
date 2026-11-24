// Wires the protocol to a pair of streams (stdin/stdout for `okayd mcp`).
// stdout carries protocol messages only; everything else goes to stderr.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createProtocol } from './protocol.js';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface McpServerOptions {
  cwd?: string;
  log?: (message: string) => void;
}

/** Serve MCP until `input` ends. Resolves after every reply is flushed. */
export function startMcpServer(input: Readable, output: Writable, options: McpServerOptions = {}): Promise<void> {
  const log = options.log ?? ((m: string) => process.stderr.write(`okayd mcp: ${m}\n`));
  const protocol = createProtocol({
    cwd: options.cwd,
    version: packageVersion(),
    log,
    write: (line) => new Promise<void>((resolve) => output.write(line + '\n', () => resolve())),
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  // Handle lines strictly in order so replies match request order.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(() => protocol.handleLine(line)).catch((e) => log(`unhandled: ${(e as Error).message}`));
  });
  return new Promise<void>((resolve) => {
    rl.on('close', () => void chain.then(resolve));
  });
}
