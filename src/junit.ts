// Reads JUnit XML, which almost every test runner can write (Playwright,
// Jest, Vitest, pytest, JUnit, Cypress, Go, ...), into test outcomes.
//
// A small dependency-free, single-pass XML tokenizer: it understands quoted
// attribute values (with ">" and "/" inside), comments, CDATA, processing
// instructions, DOCTYPE, entities, namespaces and self-closing tags. Every
// character is visited once, so the cost is linear in the input; an unclosed
// <testcase> is finished by the next one (or the end of the document).
import type { TestOutcome } from './ledger.js';

/** Largest results document accepted (characters for a string, bytes for a file). */
export const MAX_RESULTS_BYTES = 50 * 1024 * 1024;

const FLAKY_TAGS = new Set(['flakyfailure', 'flakyerror', 'rerunfailure', 'rerunerror']);
const RERUN_PROPS = new Set(['rerun', 'reruns', 'rerun_count']);

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isNameEnd = (c: number): boolean => isSpace(c) || c === 62 /* > */ || c === 47 /* / */ || c === 61 /* = */ || c === 60 /* < */ || Number.isNaN(c);

/** Decodes the five predefined entities and numeric references in one pass. Anything else stays as written. */
export function decodeEntities(s: string): string {
  let at = s.indexOf('&');
  if (at === -1) return s;
  const parts: string[] = [];
  let pos = 0;
  while (at !== -1) {
    const semi = s.indexOf(';', at + 1);
    let rep: string | undefined;
    if (semi !== -1 && semi - at <= 10) {
      const name = s.slice(at + 1, semi);
      switch (name) {
        case 'lt': rep = '<'; break;
        case 'gt': rep = '>'; break;
        case 'amp': rep = '&'; break;
        case 'quot': rep = '"'; break;
        case 'apos': rep = "'"; break;
        default:
          if (name.startsWith('#')) {
            const hex = name[1] === 'x' || name[1] === 'X';
            const digits = name.slice(hex ? 2 : 1);
            if (digits !== '' && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
              const cp = parseInt(digits, hex ? 16 : 10);
              if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) rep = String.fromCodePoint(cp);
            }
          }
      }
    }
    if (rep === undefined) {
      at = s.indexOf('&', at + 1);
      continue;
    }
    parts.push(s.slice(pos, at), rep);
    pos = semi + 1;
    at = s.indexOf('&', pos);
  }
  parts.push(s.slice(pos));
  return parts.join('');
}

interface Tag {
  /** Local name, lowercased (namespace prefix removed). */
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
}

/**
 * Reads the tag that starts at `xml[i] === "<"`. Returns the tag and the index
 * after it, or undefined when the text there is not a well-formed tag (the
 * caller then treats the "<" as text).
 */
function readTag(xml: string, i: number): { tag: Tag; next: number } | undefined {
  const n = xml.length;
  let j = i + 1;
  const closing = xml.charCodeAt(j) === 47;
  if (closing) j++;
  const nameStart = j;
  while (j < n && !isNameEnd(xml.charCodeAt(j))) j++;
  if (j === nameStart) return undefined;
  const full = xml.slice(nameStart, j);
  const colon = full.lastIndexOf(':');
  const name = (colon === -1 ? full : full.slice(colon + 1)).toLowerCase();
  const attrs: Record<string, string> = {};
  for (;;) {
    while (j < n && isSpace(xml.charCodeAt(j))) j++;
    if (j >= n) return undefined;
    const c = xml.charCodeAt(j);
    // A "<" outside quotes is not well-formed: give up here so a run of broken tags costs one pass in total.
    if (c === 60) return undefined;
    if (c === 62) return { tag: { name, attrs, closing, selfClosing: false }, next: j + 1 };
    if (c === 47) {
      if (xml.charCodeAt(j + 1) === 62) return { tag: { name, attrs, closing, selfClosing: true }, next: j + 2 };
      j++;
      continue;
    }
    const aStart = j;
    while (j < n && !isNameEnd(xml.charCodeAt(j))) j++;
    if (j === aStart) {
      j++; // stray character such as "=": skip it
      continue;
    }
    const aName = xml.slice(aStart, j);
    while (j < n && isSpace(xml.charCodeAt(j))) j++;
    if (xml.charCodeAt(j) !== 61) continue; // attribute with no value
    j++;
    while (j < n && isSpace(xml.charCodeAt(j))) j++;
    const q = xml.charCodeAt(j);
    if (q !== 34 && q !== 39) return undefined;
    const close = xml.indexOf(q === 34 ? '"' : "'", j + 1);
    if (close === -1) return undefined;
    if (!(aName in attrs)) attrs[aName] = decodeEntities(xml.slice(j + 1, close));
    j = close + 1;
  }
}

/** Index after a DOCTYPE or other "<!..." declaration, honouring quotes and an internal [subset]. */
function skipDeclaration(xml: string, i: number): number {
  const n = xml.length;
  let depth = 0;
  let quote = 0;
  for (let j = i + 2; j < n; j++) {
    const c = xml.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return j + 1;
  }
  return n;
}

interface Open {
  attrs: Record<string, string>;
  skipped: boolean;
  failed: boolean;
  flaky: boolean;
}

function outcomeOf(t: Open): TestOutcome {
  const { attrs } = t;
  const status = t.skipped ? 'skipped' : t.failed ? 'failed' : t.flaky ? 'flaky' : 'passed';
  const seconds = attrs.time ? Number(attrs.time) : undefined;
  const where = attrs.classname ? ` (${attrs.classname})` : '';
  // PHPUnit and some pytest plugins write assertions="N"; absent means unknown.
  const counted = attrs.assertions !== undefined && /^\d{1,9}$/.test(attrs.assertions.trim()) ? Number(attrs.assertions) : undefined;
  return {
    title: attrs.name ?? '',
    status,
    evidence: `${status}${seconds !== undefined && !Number.isNaN(seconds) ? ` in ${seconds.toFixed(1)}s` : ''}${where}`,
    ...(counted !== undefined ? { assertions: counted } : {}),
  };
}

export function parseJUnit(xml: string): TestOutcome[] {
  if (xml.length > MAX_RESULTS_BYTES) {
    throw new Error(`JUnit results are larger than ${MAX_RESULTS_BYTES / (1024 * 1024)} MB; refusing to parse them. Split the report or exclude noisy output (system-out).`);
  }
  const outcomes: TestOutcome[] = [];
  let open: Open | undefined;
  const finish = (): void => {
    if (open) outcomes.push(outcomeOf(open));
    open = undefined;
  };
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      i = skipDeclaration(xml, lt);
      continue;
    }
    const r = readTag(xml, lt);
    if (!r) {
      i = lt + 1;
      continue;
    }
    i = r.next;
    const { tag } = r;
    if (tag.closing) {
      if (tag.name === 'testcase' || tag.name === 'testsuite' || tag.name === 'testsuites') finish();
      continue;
    }
    if (tag.name === 'testcase') {
      finish();
      const t: Open = { attrs: tag.attrs, skipped: false, failed: false, flaky: false };
      if (tag.selfClosing) outcomes.push(outcomeOf(t));
      else open = t;
      continue;
    }
    if (tag.name === 'testsuite' || tag.name === 'testsuites') {
      finish(); // an unclosed testcase ends where the next suite begins
      continue;
    }
    if (!open) continue;
    if (tag.name === 'skipped') open.skipped = true;
    else if (tag.name === 'failure' || tag.name === 'error') open.failed = true;
    else if (FLAKY_TAGS.has(tag.name)) open.flaky = true;
    else if (tag.name === 'property') {
      const name = tag.attrs.name;
      if (name !== undefined && RERUN_PROPS.has(name.toLowerCase())) {
        const value = (tag.attrs.value ?? '1').trim().toLowerCase();
        if (value !== '0' && value !== '' && value !== 'false') open.flaky = true;
      }
    }
  }
  finish();
  return outcomes;
}
