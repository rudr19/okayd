// Playwright Test reporter. In playwright.config.ts:
//
//   reporter: [['list'], ['okayd/playwright', { dir: '.okayd' }]]
//
// Typed structurally so Okayd needs no dependency on @playwright/test.
import { finalize, type FinalizeOptions } from './finalize.js';
import type { TestOutcome } from './ledger.js';

interface PwTestCase {
  title: string;
  titlePath(): string[];
  id?: string;
}

interface PwTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  attachments: Array<{ name: string; path?: string; contentType: string }>;
}

const STATUS: Record<PwTestResult['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'timed-out',
  skipped: 'skipped',
  interrupted: 'interrupted',
};

export default class OkaydPlaywrightReporter {
  private readonly options: FinalizeOptions;
  /** Latest result per test; a pass after a retry is recorded as flaky. */
  private readonly results = new Map<string, TestOutcome>();

  constructor(options: FinalizeOptions = {}) {
    this.options = options;
  }

  onTestEnd(test: PwTestCase, result: PwTestResult): void {
    const key = test.id ?? test.titlePath().join(' > ');
    let status = STATUS[result.status];
    if (status === 'passed' && result.retry > 0) status = 'flaky';
    const trace = result.attachments.find((a) => a.name === 'trace' && a.path)?.path;
    const evidence = trace ?? `${status} in ${(result.duration / 1000).toFixed(1)}s`;
    this.results.set(key, { title: test.title, status, evidence });
  }

  async onEnd(): Promise<void> {
    const { lines } = await finalize([...this.results.values()], this.options);
    for (const line of lines) console.log(line);
  }

  printsToStdio(): boolean {
    return false;
  }
}
