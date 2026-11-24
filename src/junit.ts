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

const FLAKY_MARKERS = ['<flakyFailure', '<flakyError', '<rerunFailure', '<rerunError'];
const RERUN_PROPS = new Set(['rerun', 'reruns', 'rerun_count']);

/**
 * A testcase that passed only after a retry: Maven Surefire writes
 * <flakyFailure>/<flakyError>, Gradle and pytest-rerunfailures style plugins
 * write <rerunFailure>/<rerunError>, and some write a rerun property. Plain
 * string scans, no regex backtracking.
 */
function isFlaky(body: string): boolean {
  for (const m of FLAKY_MARKERS) if (body.includes(m)) return true;
  let from = 0;
  for (let n = 0; n < 200; n++) {
    const at = body.indexOf('<property', from);
    if (at === -1) break;
    const end = body.indexOf('>', at);
    const tag = body.slice(at, end === -1 ? at + 400 : Math.min(end, at + 400));
    const name = attr(tag, 'name');
    if (name !== undefined && RERUN_PROPS.has(name.toLowerCase())) {
      const value = (attr(tag, 'value') ?? '1').trim().toLowerCase();
      if (value !== '0' && value !== '' && value !== 'false') return true;
    }
    from = at + 9;
  }
  return false;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/** Value of name="..." inside one tag, found with plain string scans. */
function attr(tag: string, name: string): string | undefined {
  let from = 0;
  for (;;) {
    const at = tag.indexOf(name, from);
    if (at === -1) return undefined;
    from = at + name.length;
    if (at === 0 || !isSpace(tag[at - 1])) continue;
    let j = from;
    while (isSpace(tag[j])) j++;
    if (tag[j] !== '=') continue;
    j++;
    while (isSpace(tag[j])) j++;
    const q = tag[j];
    if (q !== '"' && q !== "'") continue;
    const close = tag.indexOf(q, j + 1);
    return close === -1 ? undefined : decode(tag.slice(j + 1, close));
  }
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
    else if (isFlaky(body)) status = 'flaky';
    const seconds = attrs.time ? Number(attrs.time) : undefined;
    const where = attrs.classname ? ` (${attrs.classname})` : '';
    // PHPUnit and some pytest plugins write assertions="N"; absent means unknown.
    const counted = attrs.assertions !== undefined && /^\d{1,9}$/.test(attrs.assertions.trim()) ? Number(attrs.assertions) : undefined;
    outcomes.push({
      title: attrs.name ?? '',
      status,
      evidence: `${status}${seconds !== undefined && !Number.isNaN(seconds) ? ` in ${seconds.toFixed(1)}s` : ''}${where}`,
      ...(counted !== undefined ? { assertions: counted } : {}),
    });
  }
  return outcomes;
}
