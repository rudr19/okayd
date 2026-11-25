// Wires the protocol to a pair of streams (stdin/stdout for `okproof mcp`).
// stdout carries protocol messages only; everything else goes to stderr.
import { readFileSync } from 'node:fs';
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

/** Longest input line accepted (characters). A longer one is dropped with an error instead of being buffered. */
export const MAX_LINE_CHARS = 1024 * 1024;

export interface McpServerOptions {
  cwd?: string;
  log?: (message: string) => void;
}

/** Serve MCP until `input` ends. Resolves after every reply is flushed. */
export function startMcpServer(input: Readable, output: Writable, options: McpServerOptions = {}): Promise<void> {
  const log = options.log ?? ((m: string) => process.stderr.write(`okproof mcp: ${m}\n`));
  const protocol = createProtocol({
    cwd: options.cwd,
    version: packageVersion(),
    log,
    write: (line) => new Promise<void>((resolve) => output.write(line + '\n', () => resolve())),
  });
  // Lines are split here, not by readline, so one endless line cannot grow a buffer without limit.
  let chain: Promise<void> = Promise.resolve();
  const then = (f: () => Promise<void>): void => {
    chain = chain.then(f).catch((e) => log(`unhandled: ${(e as Error).message}`));
  };
  const tooLong = (): void => then(() => protocol.rejectLine(`Input line is longer than ${MAX_LINE_CHARS} characters and was dropped.`));
  let buf = '';
  let dropping = false;
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf('\n', start);
      if (nl === -1) {
        if (!dropping) {
          buf += chunk.slice(start);
          if (buf.length > MAX_LINE_CHARS) {
            dropping = true;
            buf = '';
            tooLong();
          }
        }
        return;
      }
      if (dropping) dropping = false;
      else {
        const line = buf + chunk.slice(start, nl);
        buf = '';
        if (line.length > MAX_LINE_CHARS) tooLong();
        else then(() => protocol.handleLine(line));
      }
      start = nl + 1;
    }
  });
  return new Promise<void>((resolve) => {
    input.on('end', () => {
      if (!dropping && buf !== '') {
        const line = buf;
        then(() => protocol.handleLine(line));
      }
      void chain.then(resolve);
    });
  });
}
