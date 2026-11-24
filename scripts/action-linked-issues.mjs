// Used by action.yml: decides which issues to sync proof files with and writes
// them to the `issues` output as a comma-separated list (possibly empty).
//
//   ISSUE set   -> exactly that issue; its proof file must exist (sync fails if not).
//   ISSUE unset -> issues the PR body closes ("Closes #N" / "Fixes #N" / "Resolves #N").
//
// Two outputs:
//   issues    what to sync. sync=off: none. sync=write: every linked issue (a missing proof
//             file is created). sync=check: linked issues that already have a proof file.
//   required  every linked issue, passed to `okproof gate --require-issues` so a PR cannot
//             close #142 while its proof file is renamed, swapped or absent. Empty when
//             REQUIRE_LINKED=false (for PRs that close issues okproof does not track); then
//             sync=write only creates proof files for issues that already have one.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedIssues } from '../dist/src/sync.js';

const dir = process.env.DIR || '.okproof';
const explicit = (process.env.ISSUE || '').trim();
const sync = process.env.SYNC || 'check';
const requireLinked = (process.env.REQUIRE_LINKED || 'true') !== 'false';
let linked = [];
if (explicit) {
  if (!/^#?[1-9]\d{0,8}$/.test(explicit)) {
    console.error(`issue input must be a positive issue number, got "${explicit}".`);
    process.exit(2);
  }
  linked = [Number(explicit.replace(/^#/, ''))];
} else {
  let body = '';
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'));
    body = typeof event?.pull_request?.body === 'string' ? event.pull_request.body : '';
  } catch {
    // Not a pull request event: nothing to detect.
  }
  linked = linkedIssues(body);
  if (linked.length === 0) console.log('No linked issue found in the PR body.');
}
const hasProof = (n) => existsSync(join(dir, `${n}.md`));
const all = requireLinked || explicit;
const issues = sync === 'off' ? [] : sync === 'write' && all ? linked : explicit ? linked : linked.filter(hasProof);
const required = requireLinked || explicit ? linked : [];
const text = `issues=${issues.join(',')}\nrequired=${required.join(',')}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
else process.stdout.write(text);
