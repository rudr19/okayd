// Parses a proof file: .okproof/<issue>.md
//
//   ## #142 Pro upgrade
//   - [ ] A member can upgrade the workspace to Pro from Billing
//   - [ ] Invoice preview shows a prorated amount
//
// Each "- [ ]" line is one acceptance criterion with id "<issue>.<n>", e.g. "142.1".
// A line may carry a stable id, which does not move when criteria are added or removed:
//   - [ ] {#login} A user can sign in        -> id "142.login"
// A line may start with one {...} block of space-separated tokens:
//   - [ ] {#pay E3} Payments are charged once  -> id "142.pay", requires evidence level E3
//   #id a stable id · E0..E4 the evidence level this criterion requires · pre reserved: it already held before the change
// A test claims a criterion by putting "[okproof:142.1]" or "[okproof:142.login]" in its title.

export interface Criterion {
  id: string;
  issue: string;
  /** Position among the criteria (1-based). The id is built from it unless there is a stable id. */
  index: number;
  text: string;
  /** The `{#id}` the line carries, if any. */
  stableId?: string;
  /** Evidence level this line requires (`{E3}`, 0-4). Absent: the gate's minimum level applies. */
  level?: number;
  /** The line carries the `pre` token. */
  pre?: boolean;
}

export interface ProofFile {
  issue: string;
  title: string;
  criteria: Criterion[];
}

const HEADING = /^##\s+#?([\w-]+)\s*(.*)$/;
const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;

const STABLE_ID = /^[a-z0-9-]+$/;

export interface CriterionFlags {
  id?: string;
  /** Required evidence level 0-4, when the line names one. */
  level?: number;
  pre?: boolean;
  text: string;
}

/** True for a token that looks like an evidence level: E followed by digits (any case). */
const isLevelLike = (t: string): boolean => t.length >= 2 && (t[0] === 'E' || t[0] === 'e') && [...t.slice(1)].every((ch) => ch >= '0' && ch <= '9');

/**
 * Splits a leading `{...}` block off a criterion line. Tokens are separated by
 * spaces: `#id`, `E0`..`E4`, `pre`. A block with no recognised token (for
 * example `{JSON} is valid`) is plain text. Once any token is recognised, an
 * unknown, malformed or repeated token throws, so a typo such as `{E7}` or `{e3}`
 * is never silently ignored. Linear: one indexOf, one split.
 */
export function splitCriterionFlags(raw: string): CriterionFlags {
  if (!raw.startsWith('{')) return { text: raw };
  const close = raw.indexOf('}');
  if (close < 0) return { text: raw };
  const block = raw.slice(1, close);
  const tokens = block.split(/\s+/).filter((t) => t !== '');
  const recognised = (t: string): boolean => t.startsWith('#') || isLevelLike(t) || t === 'pre';
  if (!tokens.some(recognised)) return { text: raw };
  const out: CriterionFlags = { text: '' };
  for (const t of tokens) {
    if (t.startsWith('#')) {
      const id = t.slice(1);
      if (out.id !== undefined) throw new Error(`Criterion line has more than one id ("{#${out.id}}" and "{#${id}}").`);
      if (!STABLE_ID.test(id)) throw new Error(`Criterion id "{#${id}}" must use only a-z, 0-9 and "-", e.g. {#sign-in}.`);
      if (/^\d+$/.test(id)) throw new Error(`Criterion id "{#${id}}" must contain a letter, or it could be mistaken for a position.`);
      out.id = id;
    } else if (isLevelLike(t)) {
      const n = Number(t.slice(1));
      if (t[0] !== 'E' || t.length > 2 || n > 4) throw new Error(`Evidence level "${t}" must be one of E0, E1, E2, E3, E4.`);
      if (out.level !== undefined) throw new Error(`Criterion line names more than one evidence level (E${out.level} and ${t}).`);
      out.level = n;
    } else if (t === 'pre') {
      out.pre = true;
    } else {
      throw new Error(`Unknown token "${t}" in "{${block}}". Use #id, E0-E4 or pre, separated by spaces.`);
    }
  }
  out.text = raw.slice(close + 1).trim();
  if (out.text === '') throw new Error(`Criterion {${block}} has no text after its tokens.`);
  return out;
}

/** Splits a leading `{#id}` (or `{#id E3 pre}`) off a criterion line. Throws on an invalid id or no text. */
export function splitStableId(raw: string): { id?: string; text: string } {
  const f = splitCriterionFlags(raw);
  return f.id === undefined ? { text: f.text } : { id: f.id, text: f.text };
}

/** Renders flags back to their `{...} ` prefix ('' when there are none). */
export function formatCriterionFlags(f: { id?: string; level?: number; pre?: boolean }): string {
  const t = [f.id ? `#${f.id}` : '', f.level !== undefined ? `E${f.level}` : '', f.pre ? 'pre' : ''].filter(Boolean);
  return t.length ? `{${t.join(' ')}} ` : '';
}

export function parseProof(source: string): ProofFile {
  let issue = '';
  let title = '';
  const criteria: Criterion[] = [];
  for (const line of source.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading && !issue) {
      issue = heading[1];
      title = heading[2].trim();
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      if (!issue) throw new Error('Proof file needs a "## #<issue> <title>" heading before its criteria.');
      const index = criteria.length + 1;
      const { id: stableId, level, pre, text } = splitCriterionFlags(item[1]);
      const id = `${issue}.${stableId ?? index}`;
      if (stableId && criteria.some((c) => c.stableId === stableId)) throw new Error(`Proof file for #${issue} has a duplicate criterion id "${stableId}".`);
      criteria.push({ id, issue, index, text, ...(stableId ? { stableId } : {}), ...(level !== undefined ? { level } : {}), ...(pre ? { pre } : {}) });
    }
  }
  if (!issue) throw new Error('Proof file has no "## #<issue> <title>" heading.');
  if (criteria.length === 0) throw new Error(`Proof file for #${issue} lists no "- [ ]" criteria.`);
  return { issue, title, criteria };
}

const TAG = /\[okproof:([\w-]+\.[a-z0-9-]+)\]/g;

/** Criterion ids a test title claims, e.g. "upgrade works [okproof:142.1]". */
export function claimedCriteria(testTitle: string): string[] {
  return [...testTitle.matchAll(TAG)].map((m) => m[1]);
}

/** Checkbox lines ("- [ ]" / "- [x]") in an issue body, whitespace-normalised. */
export function issueBodyCriteria(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    if (item) out.push(splitStableId(item[1].replace(/\s+/g, ' ')).text);
  }
  return out;
}

export interface CriteriaDrift {
  /** In the issue body but not in the proof file. */
  onlyInIssue: string[];
  /** In the proof file but not in the issue body. */
  onlyInProof: string[];
}

/** Compares a proof file's criteria with an issue body's checkboxes (order ignored). */
export function compareToIssueBody(proof: ProofFile, body: string): CriteriaDrift {
  const issue = issueBodyCriteria(body);
  const mine = proof.criteria.map((c) => c.text.replace(/\s+/g, ' '));
  return {
    onlyInIssue: issue.filter((t) => !mine.includes(t)),
    onlyInProof: mine.filter((t) => !issue.includes(t)),
  };
}
