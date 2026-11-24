// Static weak-test lint. A tag is a claim; an assertion is evidence.
//
// Scans test source for tests whose title carries [okproof:<id>] and reports the
// ones whose body contains no assertion. Heuristic and runner-neutral: no
// parser, just a bracket/string/comment-aware scanner (JS, TS, Go) and an
// indentation block reader (Python). Every pass over the text is linear.
import { open, readdir } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { claimedCriteria, parseProof } from './proof.js';
import type { TestOutcome } from './ledger.js';
import { bodyWords, criterionKeywords, missingKeywords, removeTrivial, stripTags, topWords } from './relevance.js';

export interface LintOptions {
  /** Project root: where test files are searched and where ".okproof" lives. Default ".". */
  dir?: string;
  /** Limit the scan: a directory, a file, or a simple glob such as "e2e/**\/*.spec.ts". */
  tests?: string;
  /** Folder holding proof files. Default "<dir>/.okproof". */
  proofDir?: string;
  /** Make "possibly unrelated" findings fail the run (result.ok false). Default false: advisory. */
  strictRelevance?: boolean;
}

export interface LintFinding {
  file: string;
  line: number;
  ids: string[];
  /** The line holding the tag, trimmed. */
  title: string;
  /** Why a test is weak: no assertion at all, or only trivial ones such as expect(true).toBe(true). */
  reason?: 'none' | 'trivial';
  /** The test's own title without its tags (the function name for Python). Used to match a runner's outcome. */
  name?: string;
}

export interface RelevanceFinding {
  file: string;
  line: number;
  id: string;
  /** The test's own title, without the tag. */
  test: string;
  criterion: string;
  /** Key words of the criterion the test body never mentions. */
  missing: string[];
}

export interface LintResult {
  weak: LintFinding[];
  /** Tagged tests whose body shares no key word with the criterion they claim. Advisory unless strictRelevance. */
  unrelated: RelevanceFinding[];
  /** Tags naming a criterion that no proof file lists. One finding per tag. */
  dangling: LintFinding[];
  /** Criterion ids no tagged test claims. */
  untested: { id: string; text: string }[];
  filesScanned: number;
  notes: string[];
  lines: string[];
  /** True when there is no weak test and no dangling tag (and, with strictRelevance, no unrelated test). */
  ok: boolean;
}

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 5000;
const MAX_ENTRIES = 200_000;
const MAX_TAGS_PER_FILE = 5000;
/** A test body is scanned for at most this many characters. */
const MAX_BODY_CHARS = 50_000;
const PREFIX_WINDOW = 300;
const MAX_LITS = 2000;
const MAX_LIT_CHARS = 2000;
const MAX_PY_BLOCK_LINES = 2000;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SOURCE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'go']);
const TEST_NAME = /(?:\.(?:test|spec|e2e)\.[a-z]{2,3}|(?:^|\/)test_[^/]*\.py|_test\.(?:py|go))$/;

// Anything that counts as an assertion. Applied to code with strings and
// comments blanked out. No nested quantifiers: linear on any input.
const ASSERTION =
  /\bexpect\s*[.(]|\bassert|\.should\b|\bshould\s*\(|\bt\.(?:Error|Fatal)|\brequire\.|\.not\.to|\.to(?:Be|Equal|Have|Match|Throw|Contain|StrictEqual)|\bpytest\.raises/;

// ---------------------------------------------------------------------------
// Scanners

/**
 * Characters after which a "/" starts a regex literal rather than a division.
 * Also: the start of a line, and the keyword `return`. After an identifier, a
 * number, ")" or "]" a "/" is a division.
 */
const REGEX_PREV = '(,=:[!&|?{};';
/** A regex literal longer than this is not scanned: bounds the work of a "/" that never closes. */
const MAX_REGEX_CHARS = 1000;

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);

/** True when the text just before `i` is the keyword `return` (a "/" after it starts a regex). */
function afterReturn(src: string, i: number): boolean {
  let k = i - 1;
  const stop = Math.max(0, i - 64);
  while (k >= stop && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k--;
  return k >= 5 && src.slice(k - 5, k + 1) === 'return' && !isIdentChar(src[k - 6]);
}

/** Text of a regex literal for the relevance check: escapes such as \b, \d, \w become spaces, so "\bhello\b" yields "hello". */
function regexText(body: string): string {
  return body.replace(/\\[a-zA-Z]/g, ' ');
}

interface Scan {
  /** The scanned text with strings, comments and regex literals blanked. */
  code: string;
  /** Contents of the string and template literals met on the way (capped). */
  lits: string[];
  /** Absolute index where the scan stopped. */
  end: number;
}

/**
 * Walk JS/TS/Go source from `from`, tracking (), {}, [] depth outside strings,
 * template literals, comments and regex literals. Stops when depth falls below
 * the depth it had at `tagIdx` (the close of the test call), at EOF, or after
 * MAX_BODY_CHARS.
 */
export function scanBraces(src: string, from: number, tagIdx: number): Scan {
  const n = src.length;
  const limit = Math.min(n, from + MAX_BODY_CHARS);
  const parts: string[] = [];
  const lits: string[] = [];
  const lit = (a: number, b: number): void => {
    if (lits.length < MAX_LITS) lits.push(src.slice(a, Math.min(b, a + MAX_LIT_CHARS)));
  };
  let codeStart = from;
  let depth = 0;
  let floor: number | undefined;
  let last = '';
  let lineStart = true;
  let i = from;
  const blank = (to: number): void => {
    parts.push(src.slice(codeStart, i), ' ');
    i = to;
    codeStart = to;
  };
  while (i < limit) {
    if (floor === undefined && i >= tagIdx) floor = depth;
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      blank(nl === -1 ? n : nl);
    } else if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      blank(close === -1 ? n : close + 2);
    } else if (c === '/' && (lineStart || last === '' || REGEX_PREV.includes(last) || (isIdentChar(last) && afterReturn(src, i)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      const cap = Math.min(n, i + MAX_REGEX_CHARS);
      while (j < cap && src[j] !== '\n') {
        const d = src[j]!;
        if (d === '\\') j += 2;
        else {
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            closed = true;
            break;
          }
          j++;
        }
      }
      if (closed) {
        // A regex literal is text the test mentions, like a string.
        if (lits.length < MAX_LITS) lits.push(regexText(src.slice(i + 1, Math.min(j, i + 1 + MAX_LIT_CHARS))));
        blank(j + 1);
        last = 'a';
      } else {
        last = c;
        i++;
      }
      lineStart = false;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      lit(i + 1, Math.min(j, n));
      blank(Math.min(n, src[j] === '\n' ? j : j + 1));
      last = 'a';
      lineStart = false;
    } else if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      lit(i + 1, Math.min(j, n));
      blank(Math.min(n, j + 1));
      last = 'a';
      lineStart = false;
    } else {
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (floor !== undefined && depth < floor) {
          i++;
          break;
        }
      }
      if (c === '\n') lineStart = true;
      else if (c !== ' ' && c !== '\t' && c !== '\r') {
        last = c;
        lineStart = false;
      }
      i++;
    }
  }
  const end = Math.min(i, n);
  parts.push(src.slice(codeStart, end));
  return { code: parts.join(''), lits, end };
}

/** Blank Python strings (including triple-quoted) and # comments. */
export function stripPython(src: string, lits?: string[]): string {
  const lit = (a: number, b: number): void => {
    if (lits && lits.length < MAX_LITS) lits.push(src.slice(a, Math.min(b, a + MAX_LIT_CHARS)));
  };
  const n = src.length;
  const parts: string[] = [];
  let codeStart = 0;
  let i = 0;
  const blank = (to: number): void => {
    parts.push(src.slice(codeStart, i), ' ');
    i = to;
    codeStart = to;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '#') {
      const nl = src.indexOf('\n', i);
      blank(nl === -1 ? n : nl);
    } else if (c === '"' || c === "'") {
      if (src[i + 1] === c && src[i + 2] === c) {
        const close = src.indexOf(c.repeat(3), i + 3);
        lit(i + 3, close === -1 ? n : close);
        blank(close === -1 ? n : close + 3);
      } else {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        lit(i + 1, Math.min(j, n));
        blank(Math.min(n, src[j] === '\n' ? j : j + 1));
      }
    } else i++;
  }
  parts.push(src.slice(codeStart));
  return parts.join('');
}

const indentOf = (line: string): number => {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return k;
};
const DEF = /^\s*(?:async\s+)?def\s/;

// ---------------------------------------------------------------------------
// Per-file analysis

interface FoundTest {
  line: number;
  title: string;
  ids: string[];
  weak: boolean;
  trivial: boolean;
  /** The test's title or function name, without the tag. */
  name: string;
  /** Words (and stems) of the body, for the relevance check. */
  words: Set<string>;
}
interface FileFindings {
  tests: FoundTest[];
  tags: { id: string; line: number; title: string }[];
}

const TAG_AT = /\[okproof:([\w-]+\.[a-z0-9-]+)\]/y;

function lineAt(src: string, idx: number, cache: { pos: number; line: number; nl: number }): number {
  // Tags arrive in ascending order; each newline is found once (amortised linear).
  if (cache.nl < 0) cache.nl = nextNewline(src, 0);
  while (cache.nl < idx) {
    cache.line++;
    cache.pos = cache.nl + 1;
    cache.nl = nextNewline(src, cache.pos);
  }
  return cache.line;
}

function nextNewline(src: string, from: number): number {
  const nl = src.indexOf('\n', from);
  return nl === -1 ? src.length : nl;
}

function lineText(src: string, idx: number): string {
  // Bounded windows: a pathological single line must not cost a full scan per tag.
  const from = Math.max(0, idx - 120);
  const before = src.slice(from, idx);
  const start = from + before.lastIndexOf('\n') + 1;
  const after = src.slice(idx, idx + 120);
  const nl = after.indexOf('\n');
  return src.slice(start, idx + (nl === -1 ? after.length : nl)).trim();
}

export function analyzeSource(src: string, python: boolean): FileFindings {
  const out: FileFindings = { tests: [], tags: [] };
  const cache = { pos: 0, line: 1, nl: -1 };
  const pyLines = python ? src.split(/\r?\n/) : [];
  const pyTestAtDef = new Map<number, FoundTest>();
  let lastEnd = -1;
  let lastTest: FoundTest | undefined;
  let pos = 0;
  while (out.tags.length < MAX_TAGS_PER_FILE) {
    const idx = src.indexOf('[okproof:', pos);
    if (idx === -1) break;
    pos = idx + 7;
    TAG_AT.lastIndex = idx;
    const m = TAG_AT.exec(src);
    if (!m) continue;
    const id = m[1]!;
    const line = lineAt(src, idx, cache);
    out.tags.push({ id, line, title: lineText(src, idx) });

    if (python) {
      const defIdx = findPythonDef(pyLines, line - 1);
      if (defIdx === undefined) continue;
      const existing = pyTestAtDef.get(defIdx);
      if (existing) {
        if (!existing.ids.includes(id)) existing.ids.push(id);
        continue;
      }
      const lits: string[] = [];
      const code = stripPython(pythonBlock(pyLines, defIdx), lits);
      const t: FoundTest = {
        line,
        title: lineText(src, idx),
        ids: [id],
        ...judge(code),
        name: pyName(pyLines[defIdx]!),
        words: bodyWords(code, lits.filter((l) => !l.includes('[okproof:'))),
      };
      pyTestAtDef.set(defIdx, t);
      out.tests.push(t);
      continue;
    }

    if (idx < lastEnd && lastTest) {
      if (!lastTest.ids.includes(id)) lastTest.ids.push(id);
      continue;
    }
    const window = src.slice(Math.max(0, idx - PREFIX_WINDOW), idx);
    const nlInWindow = window.lastIndexOf('\n');
    const from = idx - window.length + (nlInWindow === -1 ? 0 : nlInWindow + 1);
    const scan = scanBraces(src, from, idx);
    lastEnd = scan.end;
    const own = scan.lits.find((l) => l.includes('[okproof:'));
    lastTest = {
      line,
      title: lineText(src, idx),
      ids: [id],
      ...judge(scan.code),
      name: own === undefined ? '' : stripTags(own),
      words: bodyWords(scan.code, scan.lits.filter((l) => !l.includes('[okproof:'))),
    };
    if (lastTest.name === '') lastTest.name = stripTags(lastTest.title);
    out.tests.push(lastTest);
  }
  return out;
}

/** Weak when nothing asserts, or when every assertion is trivial (expect(true).toBe(true)). */
function judge(code: string): { weak: boolean; trivial: boolean } {
  if (!ASSERTION.test(code)) return { weak: true, trivial: false };
  const rest = removeTrivial(code);
  if (rest !== code && !ASSERTION.test(rest)) return { weak: true, trivial: true };
  return { weak: false, trivial: false };
}

function pyName(defLine: string): string {
  const at = defLine.indexOf('def ');
  if (at === -1) return defLine.trim();
  let j = at + 4;
  while (defLine[j] === ' ') j++;
  let k = j;
  while (k < defLine.length && defLine[k] !== '(' && defLine[k] !== ':' && defLine[k] !== ' ') k++;
  return defLine.slice(j, k);
}

/** Index of the `def` line a tag on line `at` belongs to, if any. */
function findPythonDef(lines: string[], at: number): number | undefined {
  const here = lines[at] ?? '';
  if (DEF.test(here)) return at;
  const t = here.trimStart();
  if (t.startsWith('@') || t.startsWith('#')) {
    for (let k = at + 1; k < lines.length && k <= at + 10; k++) if (DEF.test(lines[k]!)) return k;
    return undefined;
  }
  const mine = indentOf(here);
  for (let k = at - 1; k >= 0 && k >= at - 200; k--) {
    const l = lines[k]!;
    if (DEF.test(l) && indentOf(l) < mine) return k;
  }
  return undefined;
}

function pythonBlock(lines: string[], defIdx: number): string {
  const base = indentOf(lines[defIdx]!);
  const out: string[] = [];
  for (let k = defIdx + 1; k < lines.length && out.length < MAX_PY_BLOCK_LINES; k++) {
    const l = lines[k]!;
    if (l.trim() !== '' && indentOf(l) <= base) break;
    out.push(l);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// File discovery

/** Longest glob accepted for --tests. */
export const MAX_GLOB_CHARS = 512;

/** One path segment against one pattern segment: "*" any run, "?" one character. Two pointers, no regex: O(n*m) at worst. */
function segmentMatch(p: string, s: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star !== -1) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

/**
 * Match a "/"-separated relative path against a glob: "*" (not across "/"), "?",
 * a "**" segment (any number of directories, including none), literal text.
 * No regular expression is built from the pattern. Throws when the pattern is
 * longer than MAX_GLOB_CHARS. Work is bounded by segments(pattern) * segments(path).
 */
export function globMatch(glob: string, path: string): boolean {
  if (glob.length > MAX_GLOB_CHARS) throw new Error(`--tests pattern is longer than ${MAX_GLOB_CHARS} characters`);
  const ps = glob.split('/');
  const ss = path.split('/');
  // row[j]: pattern segments consumed so far match the first j path segments
  let row = new Array<boolean>(ss.length + 1).fill(false);
  row[0] = true;
  for (const p of ps) {
    const next = new Array<boolean>(ss.length + 1).fill(false);
    if (p === '**') {
      let any = false;
      for (let j = 0; j <= ss.length; j++) {
        any = any || row[j]!;
        next[j] = any;
      }
    } else {
      for (let j = 1; j <= ss.length; j++) next[j] = row[j - 1]! && segmentMatch(p, ss[j - 1]!);
    }
    row = next;
  }
  return row[ss.length]!;
}

async function readCapped(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r');
  try {
    if ((await fh.stat()).size > MAX_FILE_BYTES) return undefined;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

interface Walk {
  files: string[];
  truncated: boolean;
}

async function walk(base: string, root: string, filter: ((rel: string) => boolean) | undefined): Promise<Walk> {
  const files: string[] = [];
  const stack = [base];
  let visited = 0;
  let truncated = false;
  while (stack.length > 0 && !truncated) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // popped in ascending order
    for (const e of entries) {
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join('/');
        const ext = e.name.slice(e.name.lastIndexOf('.') + 1);
        if (!SOURCE_EXT.has(ext) || !TEST_NAME.test(rel)) continue;
        if (filter && !filter(rel)) continue;
        if (files.length >= MAX_FILES) {
          truncated = true;
          break;
        }
        files.push(full);
      }
    }
  }
  files.sort();
  return { files, truncated };
}

async function loadCriteria(proofDir: string): Promise<{ id: string; text: string }[] | undefined> {
  let names: string[];
  try {
    names = await readdir(proofDir);
  } catch {
    return undefined;
  }
  const out: { id: string; text: string }[] = [];
  for (const n of names.filter((x) => x.endsWith('.md') && !x.startsWith('ledger-')).sort()) {
    try {
      const text = await readCapped(join(proofDir, n));
      if (text === undefined) continue;
      for (const c of parseProof(text).criteria) out.push({ id: c.id, text: c.text });
    } catch {
      // An unreadable proof file is reported by `okproof check`, not here.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function lintTests(options: LintOptions = {}): Promise<LintResult> {
  const root = resolve(options.dir ?? '.');
  const notes: string[] = [];
  let base = root;
  let filter: ((rel: string) => boolean) | undefined;
  let single: string | undefined;
  if (options.tests !== undefined && options.tests !== '') {
    const spec = options.tests.split(sep).join('/').replace(/^\.\//, '');
    if (/[*?]/.test(spec)) {
      const segs = spec.split('/');
      const firstGlob = segs.findIndex((s) => /[*?]/.test(s));
      base = resolve(root, segs.slice(0, firstGlob).join('/'));
      if (spec.length > MAX_GLOB_CHARS) throw new Error(`--tests pattern is longer than ${MAX_GLOB_CHARS} characters`);
      filter = (rel) => globMatch(spec, rel);
    } else {
      base = resolve(root, spec);
      const fh = await open(base, 'r').catch(() => undefined);
      if (!fh) throw new Error(`No such test path: ${options.tests}`);
      try {
        if ((await fh.stat()).isFile()) single = base;
      } finally {
        await fh.close();
      }
    }
  }

  let files: string[];
  if (single) files = [single];
  else {
    const w = await walk(base, root, filter);
    files = w.files;
    if (w.truncated) notes.push(`scan stopped early: more than ${MAX_FILES} test files or ${MAX_ENTRIES} entries`);
  }

  const criteria = await loadCriteria(options.proofDir ? resolve(root, options.proofDir) : join(root, '.okproof'));
  const textOf = new Map<string, string>();
  for (const c of criteria ?? []) if (!textOf.has(c.id)) textOf.set(c.id, c.text);
  const weak: LintFinding[] = [];
  const unrelated: RelevanceFinding[] = [];
  const dangling: LintFinding[] = [];
  const seenIds = new Set<string>();
  const pending: { file: string; tags: FileFindings['tags'] }[] = [];
  let scanned = 0;
  for (const f of files) {
    const rel = relative(root, f).split(sep).join('/');
    let src: string | undefined;
    try {
      src = await readCapped(f);
    } catch {
      continue;
    }
    if (src === undefined) {
      notes.push(`skipped ${rel}: larger than ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    scanned++;
    const found = analyzeSource(src, f.endsWith('.py'));
    for (const t of found.tests) {
      if (t.weak) weak.push({ file: rel, line: t.line, ids: t.ids, title: t.title, reason: t.trivial ? 'trivial' : 'none', name: t.name });
      // A test with no assertions is already reported weak; relevance is about the rest.
      if (t.weak && !t.trivial) continue;
      for (const id of t.ids) {
        const text = textOf.get(id);
        if (text === undefined) continue;
        const keys = criterionKeywords(text);
        if (keys.length === 0) continue; // nothing to compare: all stopwords
        if (missingKeywords(keys, t.words).length === keys.length) {
          unrelated.push({ file: rel, line: t.line, id, test: t.name, criterion: text, missing: topWords(keys) });
        }
      }
    }
    for (const t of found.tags) seenIds.add(t.id);
    pending.push({ file: rel, tags: found.tags });
  }

  const untested: LintResult['untested'] = [];
  if (!criteria || criteria.length === 0) {
    notes.push('no proof files found: skipped the dangling-tag and untested-criterion checks');
  } else {
    const known = new Set(criteria.map((c) => c.id));
    for (const p of pending) {
      for (const t of p.tags) if (!known.has(t.id)) dangling.push({ file: p.file, line: t.line, ids: [t.id], title: t.title });
    }
    for (const c of criteria) if (!seenIds.has(c.id)) untested.push(c);
  }

  const lines: string[] = [];
  for (const w of weak) {
    const why = w.reason === 'trivial' ? 'only trivial assertions (such as expect(true).toBe(true)) in test body' : 'no assertion in test body';
    lines.push(`WEAK      ${w.file}:${w.line}  [okproof:${w.ids.join(', ')}] ${why}: ${w.title}`);
  }
  for (const u of unrelated) {
    const text = u.criterion.length > 100 ? `${u.criterion.slice(0, 97)}...` : u.criterion;
    lines.push(`UNRELATED ${u.file}:${u.line}  possibly unrelated: test '${u.test}' claims ${u.id} ('${text}') but never mentions ${u.missing.join(', ')}`);
  }
  for (const d of dangling) lines.push(`DANGLING  ${d.file}:${d.line}  [okproof:${d.ids[0]}] no such criterion in any proof file`);
  for (const u of untested) lines.push(`UNTESTED  ${u.id}  ${u.text}: no tagged test`);
  for (const n of notes) lines.push(`note: ${n}`);
  const strictRelevance = options.strictRelevance === true;
  const ok = weak.length === 0 && dangling.length === 0 && (!strictRelevance || unrelated.length === 0);
  lines.push(
    `okproof lint: ${scanned} test file${scanned === 1 ? '' : 's'} scanned, ${weak.length} weak, ${unrelated.length} possibly unrelated${strictRelevance ? '' : ' (advisory)'}, ${dangling.length} dangling tag${dangling.length === 1 ? '' : 's'}, ${untested.length} untested criteri${untested.length === 1 ? 'on' : 'a'}`,
  );
  return { weak, unrelated, dangling, untested, filesScanned: scanned, notes, lines, ok };
}

// ---------------------------------------------------------------------------
// Feeding lint into the ledger

const norm = (s: string): string => stripTags(s).toLowerCase();

/**
 * Mark the outcomes lint found weak as having asserted nothing (assertions = 0),
 * so their criterion becomes "unproven" instead of "met". Matched by the
 * [okproof:<id>] tag plus the test title: the outcome must claim one of the
 * finding's ids and its title (tags removed) must contain the finding's test
 * name, or the other way round. A runner's own assertion count is the authority:
 * a count above zero stands, except for a test lint calls trivial. Returns new
 * outcomes; the input is not changed.
 */
export function applyLintToOutcomes(outcomes: TestOutcome[], weak: LintFinding[]): { outcomes: TestOutcome[]; marked: string[] } {
  const marked: string[] = [];
  const result = outcomes.map((o) => {
    const ids = claimedCriteria(o.title);
    if (ids.length === 0) return o;
    const title = norm(o.title);
    const hit = weak.find((f) => {
      if (!f.ids.some((id) => ids.includes(id))) return false;
      const name = f.name === undefined ? '' : norm(f.name);
      return name === '' || title.includes(name) || (title !== '' && name.includes(title));
    });
    if (!hit) return o;
    if (o.assertions !== undefined && !(hit.reason === 'trivial' && o.assertions > 0)) return o;
    marked.push(o.title);
    return { ...o, assertions: 0 };
  });
  return { outcomes: result, marked };
}

export interface LintOutcomesOptions {
  /** Project root to scan for test files. Default ".". */
  dir?: string;
  /** Limit the scan to a path or glob. Default: every test file under dir. */
  tests?: string;
  /** Folder holding proof files. */
  proofDir?: string;
  strictRelevance?: boolean;
}

export interface LintOutcomesResult {
  outcomes: TestOutcome[];
  /** Titles of outcomes marked weak by lint. */
  marked: string[];
  lint: LintResult;
  /** Human lines: one per marked test, plus advisory relevance warnings. */
  lines: string[];
  /** False only with strictRelevance and an unrelated test. */
  ok: boolean;
}

/** Run lint and apply its weak findings to `outcomes`. Relevance stays advisory unless strictRelevance. */
export async function lintOutcomes(outcomes: TestOutcome[], options: LintOutcomesOptions = {}): Promise<LintOutcomesResult> {
  const lint = await lintTests({ dir: options.dir, tests: options.tests, proofDir: options.proofDir, strictRelevance: options.strictRelevance });
  const applied = applyLintToOutcomes(outcomes, lint.weak);
  const lines: string[] = [];
  for (const m of applied.marked) lines.push(`okproof lint: marked weak (no real assertion): ${m}`);
  for (const u of lint.unrelated) lines.push(`okproof lint: possibly unrelated: test '${u.test}' claims ${u.id} but never mentions ${u.missing.join(', ')}`);
  const ok = options.strictRelevance !== true || lint.unrelated.length === 0;
  return { outcomes: applied.outcomes, marked: applied.marked, lint, lines, ok };
}
