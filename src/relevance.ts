// Heuristics behind `okproof lint`: does a tagged test mention its criterion,
// and does it assert anything non-trivial? Plain string code and bounded
// regexes only; every pass is linear in its (capped) input.

const MAX_WORDS = 5000;

const STOP = new Set(
  (
    'the and for not but nor yet any all each every only also into onto than then that this these those with without from ' +
    'have has had having can could will would shall should must may might been being was were are does did done doing ' +
    'you your our his her its their them they she him who whom whose what which when where why how there here ' +
    'able once after before while during upon about over under between within other others some such same ' +
    'via per get gets got make makes made use uses used using should either neither both few many much more most ' +
    'one two new old etc task item items criterion criteria test tests ensure ensures ensured allow allows allowed ' +
    'user users'
  ).split(' '),
);
// "user"/"users" are in STOP on purpose: almost every criterion starts with
// "A user can ...", so the word carries no signal about which test covers it.

/** Identifiers that appear in nearly every test body and say nothing about the criterion. Applied to code tokens only, never to string literals. */
const CODE_NOISE = new Set(
  (
    'expect test it describe async await const let var function return page locator assert true false null undefined self def ' +
    'import from export new this class await then catch try finally throw throws raise pytest unittest fixture beforeeach aftereach ' +
    'beforeall afterall should equal toequal tobe'
  ).split(' '),
);

const isLower = (c: number): boolean => (c >= 97 && c <= 122) || c > 127;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;

/** Split identifiers and prose into lowercase words: camelCase, snake_case, kebab-case, acronyms (HTMLParser -> html, parser). Digits and punctuation separate. */
export function splitWords(text: string, out: string[] = [], limit = MAX_WORDS): string[] {
  const n = text.length;
  let start = -1;
  const flush = (end: number): void => {
    if (start !== -1 && out.length < limit) out.push(text.slice(start, end).toLowerCase());
    start = -1;
  };
  for (let i = 0; i < n && out.length < limit; i++) {
    const c = text.charCodeAt(i);
    if (isLower(c)) {
      if (start === -1) start = i;
    } else if (isUpper(c)) {
      if (start !== -1) {
        const prev = text.charCodeAt(i - 1);
        const nextLower = i + 1 < n && isLower(text.charCodeAt(i + 1));
        // a|B boundary, or the last capital of an acronym before a lowercase run
        if (isLower(prev) || (isUpper(prev) && nextLower)) {
          flush(i);
          start = i;
        }
      } else start = i;
    } else flush(i);
  }
  flush(n);
  return out;
}

/** Plausible stems of a word: itself plus simple strips of s / es / ed / ing. Both sides of a comparison use the same function. */
export function forms(w: string): string[] {
  const out = [w];
  const n = w.length;
  if (n > 3 && w.endsWith('s')) out.push(w.slice(0, -1));
  if (n > 4 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (n > 4 && w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');
  if (n > 4 && w.endsWith('ed')) out.push(w.slice(0, -2), w.slice(0, -1));
  if (n > 5 && w.endsWith('ing')) out.push(w.slice(0, -3), w.slice(0, -3) + 'e');
  // doubled final consonant before the suffix: resetting -> resett -> reset
  if ((n > 5 && w.endsWith('ing')) || (n > 4 && w.endsWith('ed'))) {
    const base = w.slice(0, w.endsWith('ing') ? -3 : -2);
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) out.push(base.slice(0, -1));
  }
  return out;
}

/** Meaningful words of a criterion: lowercase, stopwords and words shorter than 3 characters dropped, de-duplicated, in order. */
export function criterionKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of splitWords(text.slice(0, 2000), [], 400)) {
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** Every word (and its stems) in a test body: identifiers from the code, plus string literals. */
export function bodyWords(code: string, literals: string[]): Set<string> {
  const set = new Set<string>();
  const add = (words: string[], noisy: boolean): void => {
    for (const w of words) {
      if (noisy && CODE_NOISE.has(w)) continue;
      for (const f of forms(w)) set.add(f);
    }
  };
  add(splitWords(code), true);
  const lw: string[] = [];
  for (const l of literals) {
    if (lw.length >= MAX_WORDS) break;
    splitWords(l, lw);
  }
  add(lw, false);
  return set;
}

/** Keywords of the criterion that the test body never mentions (all of them when the test is unrelated). */
export function missingKeywords(keys: string[], words: Set<string>): string[] {
  return keys.filter((k) => !forms(k).some((f) => words.has(f)));
}

/** The longest few keywords, as the "never mentions" hint. */
export function topWords(keys: string[], count = 5): string[] {
  return [...keys].sort((a, b) => b.length - a.length).slice(0, count);
}

/** Remove "[okproof:<id>]" markers and tidy whitespace. Plain string scan. */
export function stripTags(s: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    const at = s.indexOf('[okproof:', pos);
    if (at === -1) break;
    const close = s.indexOf(']', at);
    if (close === -1) break;
    parts.push(s.slice(pos, at));
    pos = close + 1;
  }
  parts.push(s.slice(pos));
  return parts.join(' ').split(/\s+/).filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Trivial assertions. Run on code whose strings are blanked to spaces.

const LIT = 'true|false|null|undefined|\\d+|None|True|False';
const TRIVIAL: RegExp[] = [
  // expect(true).toBe(true), expect(1).toEqual(1)
  new RegExp(`\\bexpect\\s*\\(\\s*(${LIT})\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\s*\\(\\s*\\1\\s*\\)`, 'g'),
  // expect('a').toBe('a') with both strings blanked
  /\bexpect\s*\(\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\)/g,
  // expect(true).toBeTruthy(), expect(false).toBeFalsy()
  /\bexpect\s*\(\s*(?:true|1)\s*\)\s*\.\s*(?:toBeTruthy|toBeTrue)\s*\(\s*\)/g,
  /\bexpect\s*\(\s*(?:false|0|null|undefined)\s*\)\s*\.\s*toBeFalsy\s*\(\s*\)/g,
  // assert(true), assert.ok(true), assert.isTrue(true)
  /\bassert(?:\s*\.\s*(?:ok|isTrue))?\s*\(\s*(?:true|1)\s*\)/g,
  // assert.equal(1, 1), assert.strictEqual(true, true)
  new RegExp(`\\bassert\\s*\\.\\s*(?:equal|strictEqual|deepEqual|deepStrictEqual|is)\\s*\\(\\s*(${LIT})\\s*,\\s*\\1\\s*\\)`, 'g'),
  // Python: assert True / assert 1 (optionally with a message), assert 1 == 1
  /\bassert[ \t]+\(?[ \t]*(?:True|1)[ \t]*\)?[ \t]*(?:,[^\n]*)?(?=\n|\r|$)/g,
  new RegExp(`\\bassert[ \\t]+(${LIT})[ \\t]*==[ \\t]*\\1\\b`, 'g'),
  // unittest: self.assertTrue(True), self.assertEqual(1, 1)
  /\bassertTrue\s*\(\s*(?:True|1)\s*\)/g,
  new RegExp(`\\bassertEqual\\s*\\(\\s*(${LIT})\\s*,\\s*\\1\\s*\\)`, 'g'),
];

/** Replace trivial assertions with a space. Returns the input unchanged when none are present. */
export function removeTrivial(code: string): string {
  let out = code;
  for (const re of TRIVIAL) out = out.replace(re, ' ');
  return out;
}
