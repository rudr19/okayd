// Reads JUnit XML, which almost every test runner can write (Playwright,
// Jest, Vitest, pytest, JUnit, Cypress, Go, ...), into test outcomes.
// A small dependency-free reader: enough for <testcase> elements and their
// <failure>, <error> and <skipped> children.
import type { TestOutcome } from './ledger.js';

const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
// An attribute name must follow whitespace, so a failed match can't rescan the
// same run of characters from every position (CodeQL js/polynomial-redos).
const ATTR = /(?<=\s)([\w:-]+)\s*=\s*"([^"]*)"/g;

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

export function parseJUnit(xml: string): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = decode(a[2]);
    const body = m[3] ?? '';
    let status = 'passed';
    if (/<skipped\b/.test(body)) status = 'skipped';
    else if (/<(failure|error)\b/.test(body)) status = 'failed';
    const seconds = attrs.time ? Number(attrs.time) : undefined;
    const where = attrs.classname ? ` (${attrs.classname})` : '';
    outcomes.push({
      title: attrs.name ?? '',
      status,
      evidence: `${status}${seconds !== undefined && !Number.isNaN(seconds) ? ` in ${seconds.toFixed(1)}s` : ''}${where}`,
    });
  }
  return outcomes;
}
