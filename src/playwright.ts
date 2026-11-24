// Playwright Test reporter. In playwright.config.ts:
//
//   reporter: [['list'], ['okproof/playwright', { dir: '.okproof' }]]
//
// Typed structurally so okproof needs no dependency on @playwright/test.
import { finalize, type FinalizeOptions } from './finalize.js';
import type { TestOutcome } from './ledger.js';

interface PwTestCase {
  title: string;
  titlePath(): string[];
  id?: string;
}

interface PwStep {
  category?: string;
  steps?: PwStep[];
}

/**
 * Count Playwright `expect` steps (soft assertions included) in a result's step
 * tree. Undefined when the result carries no step list, so the count is unknown.
 */
export function countAssertions(steps: unknown): number | undefined {
  if (!Array.isArray(steps)) return undefined;
  let count = 0;
  const stack: unknown[] = [...steps];
  while (stack.length > 0) {
    const step = stack.pop() as PwStep | null | undefined;
    if (!step || typeof step !== 'object') continue;
    if (step.category === 'expect') count++;
    if (Array.isArray(step.steps)) stack.push(...step.steps);
  }
  return count;
}

interface PwTestResult {
  steps?: PwStep[];
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

export default class OkproofPlaywrightReporter {
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
    const assertions = countAssertions(result.steps);
    this.results.set(key, { title: test.title, status, evidence, ...(assertions !== undefined ? { assertions } : {}) });
  }

  async onEnd(): Promise<void> {
    const { lines } = await finalize([...this.results.values()], this.options);
    for (const line of lines) console.log(line);
  }

  printsToStdio(): boolean {
    return false;
  }
}
