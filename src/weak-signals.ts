// Weak-assertion signals for `okproof lint`. A test is weak when nothing in it
// can fail for a reason that matters: no assertion, a trivial one, one that can
// never run, or one whose failure is swallowed. Heuristic and biased towards
// NOT flagging: a false "weak" blocks a merge, a missed one only leaves the
// existing behaviour. Input is code with strings and comments already blanked
// to spaces. Every pass is linear (brackets are paired once, up front); passes
// that look for a block end are capped.
import { removeTrivial } from './relevance.js';

/** Anything that counts as an assertion. Applied to code with strings and comments blanked out. */
export const ASSERTION =
  // Call forms only: assert(...), assert.ok(...), assertEqual(...), self.assert_called(...) and Python's `assert x` statement.
  // A bare identifier that merely starts with "assert" (`const assertions = []`, `assertEqualCount`) is not an assertion.
  /\bexpect\s*[.(]|\bassert(?:\s*\.\s*\w+){0,3}\s*\(|\bassert[A-Z_]\w*\s*\(|\bassert[ \t]+(?!from\b)[^\s=]|\.should\b|\bshould\s*\(|\bt\.(?:Error|Fatal)|\brequire\.|\.not\.to|\.to(?:Be|Equal|Have|Match|Throw|Contain|StrictEqual)|\bpytest\.raises/;

/** Objects that exist in every test and say nothing about the app: asserting they are defined proves nothing. */
export const FIXTURE_NAMES = new Set(['page', 'browser', 'context', 'browserContext', 'driver', 'app', 'client', 'request', 'server']);

export type WeakDetail =
  | 'expect.assertions(0)'
  | 'only in dead code'
  | 'only in a function the test never calls'
  | 'only inside try/catch that swallows the failure'
  | 'only constant or fixture comparisons';

const MAX_RETURNS = 200;
const MAX_DECLS = 400;

const isIdent = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$');
const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipWs(code: string, i: number): number {
  while (i < code.length && isWs(code[i])) i++;
  return i;
}

function prevSig(code: string, i: number): number {
  let k = i - 1;
  while (k >= 0 && isWs(code[k])) k--;
  return k;
}

/** Index of the next occurrence of the whole word `w` at or after `from`, or -1. */
function findWord(code: string, w: string, from: number): number {
  let at = code.indexOf(w, from);
  while (at !== -1) {
    if (!isIdent(code[at - 1]) && !isIdent(code[at + w.length])) return at;
    at = code.indexOf(w, at + w.length);
  }
  return -1;
}

const hasWord = (code: string, w: string): boolean => findWord(code, w, 0) !== -1;

/** pair[i] is the index of the bracket matching the one at i (or -1). One pass. */
function pairBrackets(code: string): Int32Array {
  const pair = new Int32Array(code.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '{' || c === '[') stack.push(i);
    else if (c === ')' || c === '}' || c === ']') {
      const o = stack.pop();
      if (o !== undefined) {
        pair[o] = i;
        pair[i] = o;
      }
    }
  }
  return pair;
}

type Range = [number, number];

function blank(code: string, ranges: Range[]): string {
  if (ranges.length === 0) return code;
  const parts: string[] = [];
  let pos = 0;
  for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    parts.push(code.slice(pos, from), ' '.repeat(b - from));
    pos = b;
  }
  parts.push(code.slice(pos));
  return parts.join('');
}

const FALSY_CONDITIONS = new Set(['false', '0', 'null', 'undefined', '!1', '!true', '0 === 1', '1 === 0']);

/** `if (false) { ... }` and `if (0) stmt;` branches: they can never run. */
function deadIfs(code: string, pair: Int32Array): Range[] {
  const out: Range[] = [];
  let at = findWord(code, 'if', 0);
  while (at !== -1 && out.length < MAX_DECLS) {
    const j = skipWs(code, at + 2);
    if (code[j] === '(' && pair[j] > j) {
      const cond = code.slice(j + 1, pair[j]).trim();
      if (FALSY_CONDITIONS.has(cond)) {
        const k = skipWs(code, pair[j] + 1);
        if (code[k] === '{' && pair[k] > k) out.push([k, pair[k] + 1]);
        else {
          let e = k;
          while (e < code.length && code[e] !== ';' && code[e] !== '\n') e++;
          out.push([k, e]);
        }
      }
    }
    at = findWord(code, 'if', at + 2);
  }
  return out;
}

/** Code after a `return` / `throw` that sits directly in a block, up to the end of that block. */
function afterTerminators(code: string): Range[] {
  const out: Range[] = [];
  let count = 0;
  for (const w of ['return', 'throw']) {
    let at = findWord(code, w, 0);
    while (at !== -1 && count < MAX_RETURNS) {
      count++;
      const p = prevSig(code, at);
      // Only a statement of its own block: `if (x) return;` and `else return;` are conditional.
      if (p < 0 || code[p] === ';' || code[p] === '{' || code[p] === '}') {
        let depth = 0;
        let stmtEnd = -1;
        let k = at + w.length;
        let last = w[w.length - 1]!;
        for (; k < code.length; k++) {
          const c = code[k]!;
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth--;
          } else if (c === ';' && depth === 0 && stmtEnd < 0) stmtEnd = k + 1;
          else if (c === '\n' && depth === 0 && stmtEnd < 0 && !'+-*/%&|^<>=?:,.(!'.includes(last)) stmtEnd = k + 1;
          if (!isWs(c)) last = c;
        }
        if (stmtEnd >= 0 && stmtEnd < k) {
          const dead = code.slice(stmtEnd, k);
          if (!hasWord(dead, 'case') && !hasWord(dead, 'default')) out.push([stmtEnd, k]);
        }
      }
      at = findWord(code, w, at + w.length);
    }
  }
  return out;
}

function identCounts(code: string): Map<string, number> {
  const counts = new Map<string, number>();
  let i = 0;
  const n = code.length;
  while (i < n) {
    if (isIdent(code[i]) && !(code[i]! >= '0' && code[i]! <= '9')) {
      let j = i + 1;
      while (j < n && isIdent(code[j])) j++;
      const w = code.slice(i, j);
      counts.set(w, (counts.get(w) ?? 0) + 1);
      i = j;
    } else if (isIdent(code[i])) {
      while (i < n && isIdent(code[i])) i++;
    } else i++;
  }
  return counts;
}

function readIdent(code: string, i: number): { name: string; end: number } | undefined {
  let j = i;
  while (j < code.length && isIdent(code[j])) j++;
  return j > i ? { name: code.slice(i, j), end: j } : undefined;
}

/**
 * Body range of a function whose parameter list closes at `paren`: the "{" right after it (or after "=>", or after a
 * same-line ": ReturnType"). Anything else is not a function body.
 */
function bodyAfterParams(code: string, paren: number, pair: Int32Array): Range | undefined {
  let k = skipWs(code, paren + 1);
  if (code[k] === ':') {
    const limit = Math.min(code.length, k + 120);
    for (k = k + 1; k < limit && code[k] !== '\n' && code[k] !== ';'; k++) {
      if (code[k] === '{' || (code[k] === '=' && code[k + 1] === '>')) break;
    }
    if (k >= limit || code[k] === '\n' || code[k] === ';') return undefined;
  }
  if (code[k] === '=' && code[k + 1] === '>') k = skipWs(code, k + 2);
  return code[k] === '{' && pair[k] > k ? [k, pair[k] + 1] : undefined;
}

/** Local functions the test declares but never mentions again: whatever they assert never runs. */
function uncalledFunctions(code: string, pair: Int32Array): Range[] {
  const counts = identCounts(code);
  const out: Range[] = [];
  let seen = 0;
  const stmtStart = (at: number): boolean => {
    let p = prevSig(code, at);
    // `async function f()` : look before the `async` too
    if (p >= 4 && code.slice(p - 4, p + 1) === 'async' && !isIdent(code[p - 5])) p = prevSig(code, p - 4);
    if (p >= 5 && code.slice(p - 5, p + 1) === 'export' && !isIdent(code[p - 6])) p = prevSig(code, p - 5);
    return p < 0 || code[p] === ';' || code[p] === '{' || code[p] === '}';
  };
  let at = findWord(code, 'function', 0);
  while (at !== -1 && seen < MAX_DECLS) {
    seen++;
    let k = skipWs(code, at + 8);
    if (code[k] === '*') k = skipWs(code, k + 1);
    const id = readIdent(code, k);
    if (id && stmtStart(at) && (counts.get(id.name) ?? 0) === 1) {
      const par = skipWs(code, id.end);
      if (code[par] === '(' && pair[par] > par) {
        const body = bodyAfterParams(code, pair[par], pair);
        if (body) out.push(body);
      }
    }
    at = findWord(code, 'function', at + 8);
  }
  for (const kw of ['const', 'let', 'var']) {
    let d = findWord(code, kw, 0);
    while (d !== -1 && seen < MAX_DECLS) {
      seen++;
      const id = readIdent(code, skipWs(code, d + kw.length));
      if (id && (counts.get(id.name) ?? 0) === 1) {
        let k = skipWs(code, id.end);
        if (code[k] === '=' && code[k + 1] !== '=' && code[k + 1] !== '>') {
          k = skipWs(code, k + 1);
          if (code.startsWith('async', k) && !isIdent(code[k + 5])) k = skipWs(code, k + 5);
          if (code.startsWith('function', k) && !isIdent(code[k + 8])) {
            let m = skipWs(code, k + 8);
            if (code[m] === '*') m = skipWs(code, m + 1);
            const nm = readIdent(code, m);
            if (nm) m = skipWs(code, nm.end);
            if (code[m] === '(' && pair[m] > m) {
              const body = bodyAfterParams(code, pair[m], pair);
              if (body) out.push(body);
            }
          } else if (code[k] === '(' && pair[k] > k) {
            const body = bodyAfterParams(code, pair[k], pair);
            if (body) out.push(body);
          } else {
            const param = readIdent(code, k);
            if (param) {
              const a = skipWs(code, param.end);
              if (code[a] === '=' && code[a + 1] === '>') {
                const b = skipWs(code, a + 2);
                if (code[b] === '{' && pair[b] > b) out.push([b, pair[b] + 1]);
              }
            }
          }
        }
      }
      d = findWord(code, kw, d + kw.length);
    }
  }
  return out;
}

/** `try { assertions } catch { }` where the catch neither rethrows nor asserts: a failing assertion is swallowed. */
function swallowedTries(code: string, pair: Int32Array): Range[] {
  const out: Range[] = [];
  let seen = 0;
  let at = findWord(code, 'try', 0);
  while (at !== -1 && seen++ < MAX_DECLS) {
    const k = skipWs(code, at + 3);
    if (code[k] === '{' && pair[k] > k) {
      const afterTry = skipWs(code, pair[k] + 1);
      if (code.startsWith('catch', afterTry) && !isIdent(code[afterTry + 5])) {
        let c = skipWs(code, afterTry + 5);
        if (code[c] === '(' && pair[c] > c) c = skipWs(code, pair[c] + 1);
        if (code[c] === '{' && pair[c] > c) {
          const body = code.slice(c + 1, pair[c]);
          if (!hasWord(body, 'throw') && !hasWord(body, 'fail') && !ASSERTION.test(body)) out.push([k, pair[k] + 1]);
        }
      }
    }
    at = findWord(code, 'try', at + 3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constant and fixture comparisons

const KEYWORD_CONST = /\b(?:true|false|null|undefined|NaN|Infinity)\b/g;

/** Text made only of numbers, arithmetic and literal keywords, with at least one number or keyword. */
export function isConstantExpr(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  // Strings are blanked before this runs, so 'a' + 'b' arrives as " + ".
  if (/^[s+()]+$/.test(t) && t.includes('+')) return true;
  let seen = /[0-9]/.test(t);
  const rest = t.replace(KEYWORD_CONST, () => {
    seen = true;
    return ' ';
  });
  if (!seen) return false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (!((c >= '0' && c <= '9') || ' \t\r\n+-*/%().!_'.includes(c))) return false;
  }
  return true;
}

const ARG_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeCloseTo']);
const NOARG_MATCHERS = new Set(['toBeTruthy', 'toBeFalsy', 'toBeDefined', 'toBeNull', 'toBeUndefined', 'toBeNaN']);
const FIXTURE_MATCHERS = new Set(['toBeDefined', 'toBeTruthy']);
const FIXTURE_NOT_MATCHERS = new Set(['toBeNull', 'toBeUndefined']);

/** Subject is a test fixture ("page") or its double negation ("!!page"). */
function fixtureSubject(subject: string): boolean {
  let s = subject.trim();
  if (s.startsWith('!!')) s = s.slice(2).trim();
  return FIXTURE_NAMES.has(s);
}

/** Blank `expect(<constant>).matcher(<constant>)` and `expect(<fixture>).toBeDefined()`-style calls. */
function trivialCalls(code: string, pair: Int32Array): Range[] {
  const out: Range[] = [];
  let at = findWord(code, 'expect', 0);
  let seen = 0;
  while (at !== -1 && seen++ < 5000) {
    const open = skipWs(code, at + 6);
    if (code[open] === '(' && pair[open] > open) {
      const subject = code.slice(open + 1, pair[open]);
      let k = skipWs(code, pair[open] + 1);
      if (code[k] === '.') {
        k = skipWs(code, k + 1);
        let negated = false;
        let m = readIdent(code, k);
        if (m && m.name === 'not') {
          negated = true;
          k = skipWs(code, m.end);
          if (code[k] === '.') {
            k = skipWs(code, k + 1);
            m = readIdent(code, k);
          } else m = undefined;
        }
        if (m) {
          const p = skipWs(code, m.end);
          if (code[p] === '(' && pair[p] > p) {
            const args = code.slice(p + 1, pair[p]);
            const constant = isConstantExpr(subject);
            const noArg = args.trim() === '';
            let trivial = false;
            if (constant && ((noArg && NOARG_MATCHERS.has(m.name)) || (ARG_MATCHERS.has(m.name) && (noArg || isConstantExpr(args))))) trivial = true;
            else if (fixtureSubject(subject) && noArg && ((!negated && FIXTURE_MATCHERS.has(m.name)) || (negated && FIXTURE_NOT_MATCHERS.has(m.name)))) trivial = true;
            else if (subject.trim().startsWith('!!') && fixtureSubject(subject) && !negated && m.name === 'toBe' && args.trim() === 'true') trivial = true;
            if (trivial) out.push([at, pair[p] + 1]);
          }
        }
      }
    }
    at = findWord(code, 'expect', at + 6);
  }
  return out;
}

const PY_CMP = ['==', '!=', '<=', '>=', '<', '>'];
const PY_FIXTURES = FIXTURE_NAMES;

/** Python: `assert 2 + 2 == 4`, `assert page`, `assert driver is not None`. */
function pythonTrivial(code: string): Range[] {
  const out: Range[] = [];
  let pos = 0;
  while (pos <= code.length) {
    let nl = code.indexOf('\n', pos);
    if (nl === -1) nl = code.length;
    const line = code.slice(pos, nl);
    const t = line.trimStart();
    if (t.startsWith('assert ') || t.startsWith('assert(')) {
      const expr = t.slice(6).trim().replace(/^\(|\)$/g, '');
      const comma = expr.indexOf(',');
      const e = (comma === -1 ? expr : expr.slice(0, comma)).trim();
      let trivial = false;
      if (PY_FIXTURES.has(e) || (e.endsWith(' is not None') && PY_FIXTURES.has(e.slice(0, -' is not None'.length).trim()))) trivial = true;
      else {
        for (const op of PY_CMP) {
          const at = e.indexOf(op);
          if (at > 0) {
            const l = e.slice(0, at);
            const r = e.slice(at + op.length);
            const py = (s: string): string => s.replace(/\b(?:True|False|None)\b/g, 'true');
            if (isConstantExpr(py(l)) && isConstantExpr(py(r))) trivial = true;
            break;
          }
        }
      }
      if (trivial) out.push([pos, nl]);
    }
    pos = nl + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface Judgement {
  weak: boolean;
  trivial: boolean;
  /** Why a test with assertions is weak anyway. */
  detail?: WeakDetail;
}

const ASSERTIONS_ZERO = /\bexpect\s*\.\s*assertions\s*\(\s*0\s*\)/;
const DECLARATIONS = /\bexpect\s*\.\s*(?:assertions\s*\([^()]*\)|hasAssertions\s*\(\s*\))/g;

/** Weak when nothing asserts, or when every assertion is trivial, can never run, or cannot fail. */
export function judge(code: string, python = false): Judgement {
  if (python) {
    if (!ASSERTION.test(code)) return { weak: true, trivial: false };
    let rest = removeTrivial(code);
    const extra = pythonTrivial(rest);
    if (extra.length > 0) rest = blank(rest, extra);
    if (rest !== code && !ASSERTION.test(rest)) return { weak: true, trivial: true, detail: extra.length > 0 ? 'only constant or fixture comparisons' : undefined };
    return { weak: false, trivial: false };
  }
  const zero = ASSERTIONS_ZERO.test(code);
  // expect.assertions(n) and expect.hasAssertions() declare a count; they are not assertions.
  const stripped = code.replace(DECLARATIONS, ' ');
  if (!ASSERTION.test(stripped)) return zero ? { weak: true, trivial: true, detail: 'expect.assertions(0)' } : { weak: true, trivial: false };
  if (zero) return { weak: true, trivial: true, detail: 'expect.assertions(0)' };

  const pair = pairBrackets(stripped);
  let detail: WeakDetail | undefined;
  const passes: [WeakDetail, Range[]][] = [
    ['only in dead code', [...deadIfs(stripped, pair), ...afterTerminators(stripped)]],
    ['only in a function the test never calls', uncalledFunctions(stripped, pair)],
    ['only inside try/catch that swallows the failure', swallowedTries(stripped, pair)],
  ];
  let live = stripped;
  for (const [why, ranges] of passes) {
    if (ranges.length === 0) continue;
    const next = blank(live, ranges);
    if (ASSERTION.test(live) && !ASSERTION.test(next)) {
      // The pass that removed the last assertion is the reason.
      detail = why;
      live = next;
      break;
    }
    live = next;
  }
  if (detail) return { weak: true, trivial: true, detail };

  const rest = removeTrivial(blank(live, trivialCalls(live, pairBrackets(live))));
  if (rest !== live && !ASSERTION.test(rest)) {
    return { weak: true, trivial: true, detail: isTrivialPlain(live) ? undefined : 'only constant or fixture comparisons' };
  }
  return { weak: false, trivial: false };
}

/** True when the classic trivial patterns alone (expect(true).toBe(true) ...) empty the body of assertions. */
function isTrivialPlain(code: string): boolean {
  const rest = removeTrivial(code);
  return rest !== code && !ASSERTION.test(rest);
}
