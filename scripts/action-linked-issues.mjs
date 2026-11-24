// Used by action.yml: decides which issues to sync proof files with and writes
// them to the `issues` output as a comma-separated list (possibly empty).
//
//   ISSUE set   -> exactly that issue; its proof file must exist (sync fails if not).
//   ISSUE unset -> issues the PR body closes ("Closes #N" / "Fixes #N" / "Resolves #N")
//                  that already have a proof file in $DIR. Linked issues without one
//                  are skipped, since a PR may close issues okproof does not track.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedIssues } from '../dist/src/sync.js';

const dir = process.env.DIR || '.okproof';
const explicit = (process.env.ISSUE || '').trim();
let issues = [];
if (explicit) {
  if (!/^#?[1-9]\d{0,8}$/.test(explicit)) {
    console.error(`issue input must be a positive issue number, got "${explicit}".`);
    process.exit(2);
  }
  issues = [Number(explicit.replace(/^#/, ''))];
} else {
  let body = '';
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'));
    body = typeof event?.pull_request?.body === 'string' ? event.pull_request.body : '';
  } catch {
    // Not a pull request event: nothing to detect.
  }
  issues = linkedIssues(body).filter((n) => existsSync(join(dir, `${n}.md`)));
  if (issues.length === 0) console.log('No linked issue with a proof file found in the PR body; skipping sync.');
}
const text = `issues=${issues.join(',')}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
else process.stdout.write(text);
