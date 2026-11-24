import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LaunchOptions {
  executablePath?: string;
  headless?: boolean;
  timeoutMs?: number;
  args?: string[];
}

export interface LaunchedChrome {
  wsEndpoint: string;
  process: ChildProcess;
  kill(): Promise<void>;
}

function candidates(): string[] {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((x): x is string => !!x);
    const rel = [
      'Google/Chrome/Application/chrome.exe',
      'Chromium/Application/chrome.exe',
      'Microsoft/Edge/Application/msedge.exe',
    ];
    return roots.flatMap((r) => rel.map((p) => join(r, p)));
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
}

/** Returns the path to a Chrome/Chromium/Edge binary, or undefined. OKAYD_CHROME wins. */
export function findChrome(): string | undefined {
  const fromEnv = process.env.OKAYD_CHROME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return candidates().find((p) => existsSync(p));
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<LaunchedChrome> {
  const executablePath = opts.executablePath ?? findChrome();
  if (!executablePath) {
    throw new Error('No Chrome, Chromium or Edge found. Install one, or set OKAYD_CHROME to its path.');
  }
  const timeoutMs = opts.timeoutMs ?? 15000;
  const profile = mkdtempSync(join(tmpdir(), 'okayd-chrome-'));
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...((opts.headless ?? true) ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...(opts.args ?? []),
    'about:blank',
  ];

  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let exited = false;
  let killing: Promise<void> | undefined;
  child.once('exit', () => { exited = true; });

  const cleanup = (): void => {
    for (let i = 0; i < 5; i++) {
      try { rmSync(profile, { recursive: true, force: true }); return; } catch { /* Windows may still hold locks */ }
    }
  };
  const kill = (): Promise<void> => {
    killing ??= new Promise<void>((resolve) => {
      const finish = (): void => { setTimeout(() => { cleanup(); resolve(); }, exited ? 0 : 200); };
      if (exited) { finish(); return; }
      child.once('exit', () => { exited = true; finish(); });
      child.kill();
      setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000).unref();
    });
    return killing;
  };

  try {
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        reject(new Error(`Chrome did not report a DevTools endpoint within ${timeoutMs}ms.${buf ? ` Output: ${buf.trim().slice(-500)}` : ''}`));
      }, timeoutMs);
      child.stderr!.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[1]!); }
      });
      child.once('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start ${executablePath}: ${e.message}`)); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (${signal ?? `code ${code}`}).${buf ? ` Output: ${buf.trim().slice(-500)}` : ''}`));
      });
    });
    // Keep draining stderr so the pipe never fills.
    child.stderr!.removeAllListeners('data');
    child.stderr!.resume();
    return { wsEndpoint, process: child, kill };
  } catch (e) {
    await kill();
    throw e;
  }
}
