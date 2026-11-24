// Parses a proof file: .okproof/<issue>.md
//
//   ## #142 Pro upgrade
//   - [ ] A member can upgrade the workspace to Pro from Billing
//   - [ ] Invoice preview shows a prorated amount
//
// Each "- [ ]" line is one acceptance criterion with id "<issue>.<n>", e.g. "142.1".
// A line may carry a stable id, which does not move when criteria are added or removed:
//   - [ ] {#login} A user can sign in        -> id "142.login"
// A test claims a criterion by putting "[okproof:142.1]" or "[okproof:142.login]" in its title.

export interface Criterion {
  id: string;
  issue: string;
  /** Position among the criteria (1-based). The id is built from it unless there is a stable id. */
  index: number;
  text: string;
  /** The `{#id}` the line carries, if any. */
  stableId?: string;
}

export interface ProofFile {
  issue: string;
  title: string;
  criteria: Criterion[];
}

const HEADING = /^##\s+#?([\w-]+)\s*(.*)$/;
const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;

const STABLE_ID = /^[a-z0-9-]+$/;

/** Splits a leading `{#id}` off a criterion line. Throws on an invalid id or an id with no text. */
export function splitStableId(raw: string): { id?: string; text: string } {
  if (!raw.startsWith('{#')) return { text: raw };
  const close = raw.indexOf('}');
  if (close < 0) return { text: raw };
  const id = raw.slice(2, close);
  const text = raw.slice(close + 1).trim();
  if (!STABLE_ID.test(id)) throw new Error(`Criterion id "{#${id}}" must use only a-z, 0-9 and "-", e.g. {#sign-in}.`);
  if (/^\d+$/.test(id)) throw new Error(`Criterion id "{#${id}}" must contain a letter, or it could be mistaken for a position.`);
  if (text === '') throw new Error(`Criterion {#${id}} has no text after its id.`);
  return { id, text };
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
      const { id: stableId, text } = splitStableId(item[1]);
      const id = `${issue}.${stableId ?? index}`;
      if (stableId && criteria.some((c) => c.stableId === stableId)) throw new Error(`Proof file for #${issue} has a duplicate criterion id "${stableId}".`);
      criteria.push({ id, issue, index, text, ...(stableId ? { stableId } : {}) });
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
