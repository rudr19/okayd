# okproof

**Your agent says it's done. okproof proves it, criterion by criterion.**

[![CI](https://github.com/rudr19/okproof/actions/workflows/ci.yml/badge.svg)](https://github.com/rudr19/okproof/actions/workflows/ci.yml)
[![CodeQL](https://github.com/rudr19/okproof/actions/workflows/codeql.yml/badge.svg)](https://github.com/rudr19/okproof/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/rudr19/okproof/badge)](https://scorecard.dev/viewer/?uri=github.com/rudr19/okproof)
[![npm version](https://img.shields.io/npm/v/okproof.svg)](https://www.npmjs.com/package/okproof)
[![License](https://img.shields.io/github/license/rudr19/okproof.svg)](LICENSE)

> Browser agents act. Test frameworks run. CI reports. **okproof proves.**
> [Why okproof](WHY-OKPROOF.md) · [Vision](VISION.md) · [Roadmap](ROADMAP.md) · [Governance](GOVERNANCE.md) · [Security](SECURITY.md)

okproof checks a pull request against the acceptance criteria in its issue.
The criteria go in a proof file in the repo. Tests claim criteria by tag. The
run ends with a ledger that marks each criterion **met**, **failed** or
**untested**. Untested never counts as a pass, and neither does a flaky pass.

okproof doesn't run your tests. It works with **Playwright Test** directly, and
with **any runner that writes JUnit XML**: Jest, Vitest, pytest, JUnit,
Cypress, Go and more. It has no runtime dependencies.

## Install

```bash
npm i -D okproof
npx okproof check
```

okproof has no runtime dependencies. The core (proof files, ledger, gate,
ingest, MCP server, Playwright reporter) runs on Node 20 or later. The browser
driver and the verifier use Node's built-in WebSocket and need Node 22 or later.

## See it in action

An agent says "All 5 acceptance criteria are implemented and tested. Done."
okproof checks the claim against the criteria in the issue:

```text
  Agent says: Done (5/5)
  okproof: 3 met · 1 failed · 1 untested — NOT PROVEN
```

Three criteria pass in a real browser. One fails, and a verifier refutation is
confirmed by replaying it with no model. One has no test at all. The gate exits
1. Run it yourself with `npm run demo` (no API key needed), or read
[the demo](examples/demo/README.md) and its
[ledger](examples/demo/out/ledger-101.md).

| Before reload | After reload |
| --- | --- |
| ![Team notes with one note in the list](examples/demo/out/before-reload.png) | ![Team notes with an empty list after reload](examples/demo/out/after-reload.png) |

## 1. Write a proof file

`.okproof/142.md`:

```md
## #142 Pro upgrade
- [ ] A member can upgrade the workspace to Pro from Billing
- [ ] Invoice preview shows a prorated amount before confirming
- [ ] A viewer (non-admin) cannot see the upgrade button
```

Run `npx okproof check` to print the tag for each criterion.

## 2. Claim criteria in test names

```ts
test('member upgrades to Pro [okproof:142.1] [okproof:142.2]', async ({ page }) => {
  // ...
});
```

## 3. Build the ledger

**Playwright Test**: add the reporter.

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['okproof/playwright']],
});
```

A test that passes only after a retry counts as flaky, which is not proven.
When Playwright records a trace, the ledger links it as evidence.

**Any other runner**: write JUnit XML, then ingest it.

```bash
npx vitest run --reporter=junit --outputFile=junit.xml
npx okproof ingest junit.xml
```

Or use CTRF (Common Test Report Format, ctrf.io). Many runners have a CTRF
reporter; ingest the JSON it writes. A test with `flaky: true` or retries that
passes is flaky, which is not proven.

```bash
npx okproof ingest ctrf-report.json
```

`ingest` picks the format from the file (`.json` is CTRF, otherwise JUnit XML).
Force it with `--format junit` or `--format ctrf`.

Both write `.okproof/ledger-<issue>.json` and `.md`. In GitHub Actions they also
write the ledger to the job summary and post it as one pull request comment
that reruns update. Give the job `pull-requests: write`, or pass
`{ github: false }` to turn this off.

## 4. Gate the merge

`npx okproof gate` exits 1 unless every criterion is met. Make it a required
check.

## Weak tests

A tag is a claim; an assertion is evidence. A tagged test that passes but makes
zero assertions proves nothing, so okproof will not call its criterion met.
Silence is not proof.

A criterion gets one of four verdicts:

- `failed`: any claiming test failed, was flaky, skipped or timed out.
- `unproven` (shown as "UNPROVEN (no assertions)"): the claiming tests passed, but every one of them is weak. The ledger lists the weak test titles.
- `met`: all claiming tests passed and at least one made a real assertion.
- `untested`: no test claims it.

A test is weak when its assertion count is exactly `0`. An unknown count (the
runner did not say) is not weak, so runners without counts keep working. Pass
`--strict-assertions` (or set `OKPROOF_STRICT_ASSERTIONS=1`) to `okproof ingest`,
or `strictAssertions: true` to the reporter, to treat unknown as weak.

How each runner reports counts:

- **Playwright reporter**: counts `expect` steps in the result's step tree, nested ones and `expect.soft` included. A result with no step list is unknown.
- **JUnit**: the `assertions="N"` attribute on `<testcase>` (PHPUnit style). Absent means unknown.
- **CTRF**: `extra.assertions` on a test, when it is a number. Otherwise unknown.

A confirmed verifier refutation still makes a criterion `failed`.

### `okproof lint`

A static check that needs no test run:

```bash
npx okproof lint                       # scan the working directory
npx okproof lint --tests e2e           # limit to a path, file or glob such as "e2e/**/*.spec.ts"
```

It finds tests whose title has `[okproof:<id>]` and reports the ones with no
assertion in the body (`expect(`, `assert`, `.should(`, `t.Error`, `t.Fatal`,
`require.`, `toBe`, `toEqual`, `toHave`, ...). It also reports tags naming a
criterion that no proof file lists, and criteria no tagged test claims. It
exits 1 on a weak test or a dangling tag. Untested criteria are listed but do
not fail the run. Also available as `lintTests()` and the `okproof_lint` MCP tool.

It scans `*.test.*`, `*.spec.*`, `*.e2e.*`, `test_*.py`, `*_test.py` and
`*_test.go`, skipping `node_modules`, `dist` and `.git`, files over 1 MB and
anything past 5000 files. It is a heuristic with no parser: it follows
brackets while skipping strings, comments and regex literals (JS, TS, Go) or
reads the indented block (Python). Put the tag in the test title. A test
that only calls a helper which asserts is reported weak, and a tag in a comment
above a test is not followed. Treat a hit as a prompt to look, not a verdict.
The ledger counts from your runner are the authority.

## Keep criteria in sync with the issue

The GitHub issue is the source of truth. Instead of copying its checkboxes by hand:

```sh
npx okproof sync --issue 142            # needs GITHUB_REPOSITORY (or --repo owner/name) and GITHUB_TOKEN/GH_TOKEN
npx okproof sync --issue 142 --body-file issue.md [--title "Pro upgrade"]   # offline
npx okproof sync --issue 142 --check    # CI: change nothing, exit 1 on drift
```

This writes `.okproof/142.md` (or the `[dir]` you pass; it must be inside the current directory). Rules:

- `- [ ]`, `- [x]` and `* [ ]` lines count; checkboxes inside fenced code blocks do not.
- If the issue has a heading named "Acceptance criteria" (any level), only the checkboxes under it count, up to the next heading of the same or higher level. Otherwise all checkboxes count.
- On an existing file, criteria already there keep their order and ids, new ones are appended, deleted ones are removed. Reordering in the issue alone is not drift.
- Ids are positional (`142.<n>`), so removing a middle criterion renumbers the later ones. okproof prints a warning listing `[okproof:142.3] -> [okproof:142.2]` so you can re-tag those tests.
- The file is rewritten from the issue, so hand-added notes in it are lost. An edited checkbox counts as one removed and one added.
- With `--body-file` the title comes from `--title`, else the first heading that is not "Acceptance criteria", else the file's current title.
- `--check` fails with "proof file is out of date with issue #n; run okproof sync".

In the Action, `sync: check` (the default) does this on every run. It uses the `issue` input, or else the issues the PR body closes ("Closes #N", "Fixes #N", "Resolves #N" in the same repo, ignoring code blocks and HTML comments) that already have a proof file in `dir`. `sync: write` only rewrites the files in the workspace; committing them is up to your workflow. `sync: off` skips it.

## GitHub Action

okproof ships as a composite action. Run your tests so they write JUnit XML, then
call it:

```yaml
name: okproof
on: pull_request

jobs:
  prove:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # lets okproof post and update its one PR comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx vitest run --reporter=junit --outputFile=junit.xml
      - id: okproof
        uses: rudr19/okproof@v0
        with:
          results: junit.xml
      - run: echo "proven=${{ steps.okproof.outputs.proven }}"
```

Inputs: `results` (JUnit XML path, optional), `dir` (default `.okproof`),
`gate` (default `true`, fail unless proven), `comment` (default `true`),
`issue` (issue number to sync from; default: detected from the PR body),
`sync` (`check` default, `write` or `off`), `node-version` (default `22`), `github-token` (default `${{ github.token }}`).
Outputs: `proven` (`true` or `false`) and `summary` (one line per proof file).
Set `comment: false` to skip the PR comment and job summary (for forks, or
when you only want the gate). The CLI honours the same switch as
`OKPROOF_NO_COMMENT=1`.

Releases are tagged `v0.x`, and a moving `v0` tag points at the latest one.
Pin `@v0` to follow it, or a full `v0.x.y` tag to hold still.

## Browser driver

okproof ships its own Chrome driver with zero runtime dependencies. It speaks the
DevTools Protocol directly over Node's built-in WebSocket (Node 22 or later) and
is built for agents: it returns short text snapshots of the accessibility tree
and acts by ref.

```ts
import { Browser } from 'okproof/driver';

const browser = await Browser.launch();
try {
  const page = await browser.newPage();
  await page.goto('https://example.com');
  const { text } = await page.snapshot(); // - link "More information..." [ref=e1]
  await page.click('e1');
  console.log(await page.title(), page.problems());
} finally {
  await browser.close();
}
```

Set `OKPROOF_CHROME` to use a specific Chrome, Chromium or Edge binary. Refs are
only valid until the next snapshot.

## Verifier

`okproof verify` points an adversarial QA agent at your running app (a preview
deployment, say) and tells it to prove each criterion **false**. It tries other
roles, bad and huge input, double submit, reload mid-flow, back, keyboard-only,
a 375px viewport and offline. It acts only through the driver above.

Models guess, so a claim is never trusted on its own. Every action is recorded
as plain JSON. A violation counts only if its assertion **fails again when the
recorded actions are replayed with no model**, in a fresh browser. Otherwise it
is listed as unconfirmed and does not fail the criterion.

```bash
export OKPROOF_ANTHROPIC_API_KEY=...        # explicit key, see below
npx okproof verify --url https://preview.example.com --issue 142
```

Options: `--dir .okproof`, `--max-steps 15`, `--model claude-opus-5-5`,
`--effort medium`. It writes:

- `.okproof/verify-<issue>.json`: a verdict per criterion (`refuted`, `held` or
  `inconclusive`), findings, and the recorded actions
- `.okproof/repro/<criterion>.json`: a model-free regression script
- `.okproof/screenshots/`: a screenshot of each confirmed failure

`okproof ingest` then reads `verify-<issue>.json`: a criterion with a confirmed
refutation becomes **failed** with the evidence `refuted by verifier: <title>
(repro: .okproof/repro/<id>.json)`, whatever the tests said.

**Replay for free.** `okproof verify --replay-only [--url ...]` re-runs the saved
repro scripts with no model and no key. It exits 1 while a bug still
reproduces, so a fixed bug becomes a free regression check in CI.

**Deterministic detectors** run after every action, with no model: console
errors, uncaught exceptions, failed requests and HTTP 4xx/5xx, interactive
elements with no accessible name, horizontal overflow, and (opt in, same
origin, at most 20 links) broken links. They are confirmed the same way, by
reappearing on replay. A confirmed finding of severity 3 or more refutes the
criterion. Unnamed controls and overflow are severity 2: reported, not failing.

**Which account pays.** The Anthropic adapter needs an explicit key, either
`new AnthropicModel({ apiKey })` or `OKPROOF_ANTHROPIC_API_KEY`. It never falls
back to `ANTHROPIC_API_KEY`, auth tokens or CLI profiles, so you choose which
account pays. Without a key, `okproof verify` exits 2. `@anthropic-ai/sdk` is an
optional peer dependency, loaded only when used: `npm i @anthropic-ai/sdk`. The
core stays dependency free, and any `ModelClient` works:

```ts
import { verify, AnthropicModel } from 'okproof/verify';
await verify({ baseUrl, model: new AnthropicModel({ apiKey }), dir: '.okproof' });
```

Status: the replay, detectors, agent loop and ledger integration are tested
against a scripted fake model. The Anthropic adapter is **not yet tested
against the live API**; its request and response shapes follow the SDK docs
and are checked against a fake client only. Known limits: broken-link checks
send no cookies; the key set is Enter, Tab, Escape, Backspace and arrows; one
tab, no file uploads or dialogs.

## Use with coding agents

`okproof mcp` runs an MCP server over stdio (no dependencies) so Claude Code,
Cursor and Codex can check the definition of done before they claim a task is
finished. For Claude Code, add this to `.mcp.json`:

```json
{ "mcpServers": { "okproof": { "command": "npx", "args": ["okproof", "mcp"] } } }
```

Tools (all take an optional `dir`, default `.okproof`, which must stay inside the
working directory):

- `okproof_criteria` lists criteria and the `[okproof:<issue>.<n>]` tag for each test title.
- `okproof_status` says "Done" or "Not done" and lists the unmet criteria. Call it before saying a task is finished.
- `okproof_ingest_junit` builds ledgers from a JUnit XML report.
- `okproof_lint` finds tagged tests with no assertion, dangling tags and untested criteria. `okproof_status` reports criteria whose tests passed without asserting as unproven and names the tests.
- `okproof_add_criterion` appends a criterion. Agents can add criteria but not remove or edit them.

`skills/okproof/SKILL.md` is a Claude Code skill that tells agents to follow this
loop. Copy it to `.claude/skills/okproof/SKILL.md`.

## Roadmap

- [x] Proof files, ledger, merge gate
- [x] Ledger posted as one PR comment (updated on reruns) and in the job summary
- [x] Playwright Test reporter and JUnit ingest for any runner
- [x] Own Chrome driver (DevTools Protocol, no dependencies)
- [x] MCP server so coding agents check "done" through okproof
- [x] CTRF ingest
- [x] Verifier agent that attacks each criterion on the preview deployment
- [x] Weak-test check: a tagged test that asserts nothing cannot make a criterion met
- [ ] "Harden": commit passing verifier runs as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "okproof" is a
trademark of its author; see [TRADEMARK.md](TRADEMARK.md). Contributions need a
signed CLA (see [CLA.md](CLA.md)). Official releases are published only by this
repo's release workflow, with npm provenance.
