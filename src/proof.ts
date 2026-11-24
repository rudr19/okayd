// Parses a proof file: .okproof/<issue>.md
//
//   ## #142 Pro upgrade
//   - [ ] A member can upgrade the workspace to Pro from Billing
//   - [ ] Invoice preview shows a prorated amount
//
// Each "- [ ]" line is one acceptance criterion with id "<issue>.<n>", e.g. "142.1".
// A test claims a criterion by putting "[okproof:142.1]" in its title.

export interface Criterion {
  id: string;
  issue: string;
  index: number;
  text: string;
}

export interface ProofFile {
  issue: string;
  title: string;
  criteria: Criterion[];
}

const HEADING = /^##\s+#?([\w-]+)\s*(.*)$/;
const ITEM = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/;

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
      criteria.push({ id: `${issue}.${index}`, issue, index, text: item[1] });
    }
  }
  if (!issue) throw new Error('Proof file has no "## #<issue> <title>" heading.');
  if (criteria.length === 0) throw new Error(`Proof file for #${issue} lists no "- [ ]" criteria.`);
  return { issue, title, criteria };
}

const TAG = /\[okproof:([\w-]+\.\d+)\]/g;

/** Criterion ids a test title claims, e.g. "upgrade works [okproof:142.1]". */
export function claimedCriteria(testTitle: string): string[] {
  return [...testTitle.matchAll(TAG)].map((m) => m[1]);
}

/** Checkbox lines ("- [ ]" / "- [x]") in an issue body, whitespace-normalised. */
export function issueBodyCriteria(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    if (item) out.push(item[1].replace(/\s+/g, ' '));
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
