// Reads CTRF (Common Test Report Format, ctrf.io) JSON into test outcomes.
// Many runners have a CTRF reporter, so this covers them without JUnit.
import type { TestOutcome } from './ledger.js';

interface CtrfAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}

interface CtrfTest {
  name?: string;
  status?: string;
  duration?: number;
  flaky?: boolean;
  retries?: number;
  filePath?: string;
  attachments?: CtrfAttachment[];
}

function statusOf(t: CtrfTest): string {
  switch (t.status) {
    case 'passed':
      return t.flaky === true || (t.retries ?? 0) > 0 ? 'flaky' : 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'pending':
      return 'skipped';
    default:
      return 'other';
  }
}

function evidenceOf(t: CtrfTest, status: string): string {
  const atts = Array.isArray(t.attachments) ? t.attachments : [];
  const usable = atts.filter((a) => typeof a?.path === 'string' && a.path !== '');
  const wanted = usable.find((a) => /trace|screenshot/i.test(`${a.name ?? ''} ${a.contentType ?? ''} ${a.path}`));
  if (wanted?.path) return wanted.path;
  const seconds = typeof t.duration === 'number' && Number.isFinite(t.duration) ? ` in ${(t.duration / 1000).toFixed(1)}s` : '';
  const where = t.filePath ? ` (${t.filePath})` : '';
  return `${status}${seconds}${where}`;
}

export function parseCTRF(input: string | object): TestOutcome[] {
  let doc: unknown = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (err) {
      throw new Error(`Not valid CTRF JSON: ${(err as Error).message}`);
    }
  }
  const tests = (doc as { results?: { tests?: unknown } } | null)?.results?.tests;
  if (!Array.isArray(tests)) {
    throw new Error('Not a CTRF report: expected results.tests to be an array.');
  }
  return (tests as CtrfTest[]).map((t) => {
    const status = statusOf(t);
    return { title: t.name ?? '', status, evidence: evidenceOf(t, status) };
  });
}
