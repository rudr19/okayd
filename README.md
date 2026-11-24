# Okayd

**Your agent says it's done. Okayd proves it, criterion by criterion.**

> Browser agents act. Test frameworks run. CI reports. **Okayd proves.**
> [Why Okayd](WHY-OKAYD.md) · [Vision](VISION.md) · [Roadmap](ROADMAP.md) · [Governance](GOVERNANCE.md) · [Security](SECURITY.md)

Okayd checks a pull request against the acceptance criteria in its issue.
The criteria go in a proof file in the repo. Tests claim criteria by tag. The
run ends with a ledger that marks each criterion **met**, **failed** or
**untested**. Untested never counts as a pass, and neither does a flaky pass.

Okayd doesn't run your tests. It works with **Playwright Test** directly, and
with **any runner that writes JUnit XML**: Jest, Vitest, pytest, JUnit,
Cypress, Go and more. It has no runtime dependencies.

## 1. Write a proof file

`.okayd/142.md`:

```md
## #142 Pro upgrade
- [ ] A member can upgrade the workspace to Pro from Billing
- [ ] Invoice preview shows a prorated amount before confirming
- [ ] A viewer (non-admin) cannot see the upgrade button
```

Run `npx okayd check` to print the tag for each criterion.

## 2. Claim criteria in test names

```ts
test('member upgrades to Pro [okayd:142.1] [okayd:142.2]', async ({ page }) => {
  // ...
});
```

## 3. Build the ledger

**Playwright Test**: add the reporter.

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [['list'], ['okayd/playwright']],
});
```

A test that passes only after a retry counts as flaky, which is not proven.
When Playwright records a trace, the ledger links it as evidence.

**Any other runner**: write JUnit XML, then ingest it.

```bash
npx vitest run --reporter=junit --outputFile=junit.xml
npx okayd ingest junit.xml
```

Or use CTRF (Common Test Report Format, ctrf.io). Many runners have a CTRF
reporter; ingest the JSON it writes. A test with `flaky: true` or retries that
passes is flaky, which is not proven.

```bash
npx okayd ingest ctrf-report.json
```

`ingest` picks the format from the file (`.json` is CTRF, otherwise JUnit XML).
Force it with `--format junit` or `--format ctrf`.

Both write `.okayd/ledger-<issue>.json` and `.md`. In GitHub Actions they also
write the ledger to the job summary and post it as one pull request comment
that reruns update. Give the job `pull-requests: write`, or pass
`{ github: false }` to turn this off.

## 4. Gate the merge

`npx okayd gate` exits 1 unless every criterion is met. Make it a required
check.

## GitHub Action

Okayd ships as a composite action. Run your tests so they write JUnit XML, then
call it:

```yaml
name: Okayd
on: pull_request

jobs:
  prove:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # lets Okayd post and update its one PR comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx vitest run --reporter=junit --outputFile=junit.xml
      - id: okayd
        uses: rudr19/okayd@v0
        with:
          results: junit.xml
      - run: echo "proven=${{ steps.okayd.outputs.proven }}"
```

Inputs: `results` (JUnit XML path, optional), `dir` (default `.okayd`),
`gate` (default `true`, fail unless proven), `comment` (default `true`),
`node-version` (default `22`), `github-token` (default `${{ github.token }}`).
Outputs: `proven` (`true` or `false`) and `summary` (one line per proof file).
Set `comment: false` to skip the PR comment and job summary (for forks, or
when you only want the gate). The CLI honours the same switch as
`OKAYD_NO_COMMENT=1`.

Releases are tagged `v0.x`, and a moving `v0` tag points at the latest one.
Pin `@v0` to follow it, or a full `v0.x.y` tag to hold still.

## Browser driver

Okayd ships its own Chrome driver with zero runtime dependencies. It speaks the
DevTools Protocol directly over Node's built-in WebSocket (Node 22 or later) and
is built for agents: it returns short text snapshots of the accessibility tree
and acts by ref.

```ts
import { Browser } from 'okayd/driver';

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

Set `OKAYD_CHROME` to use a specific Chrome, Chromium or Edge binary. Refs are
only valid until the next snapshot.

## Verifier

`okayd verify` points an adversarial QA agent at your running app (a preview
deployment, say) and tells it to prove each criterion **false**. It tries other
roles, bad and huge input, double submit, reload mid-flow, back, keyboard-only,
a 375px viewport and offline. It acts only through the driver above.

Models guess, so a claim is never trusted on its own. Every action is recorded
as plain JSON. A violation counts only if its assertion **fails again when the
recorded actions are replayed with no model**, in a fresh browser. Otherwise it
is listed as unconfirmed and does not fail the criterion.

```bash
export OKAYD_ANTHROPIC_API_KEY=...        # explicit key, see below
npx okayd verify --url https://preview.example.com --issue 142
```

Options: `--dir .okayd`, `--max-steps 15`, `--model claude-opus-5-5`,
`--effort medium`. It writes:

- `.okayd/verify-<issue>.json`: a verdict per criterion (`refuted`, `held` or
  `inconclusive`), findings, and the recorded actions
- `.okayd/repro/<criterion>.json`: a model-free regression script
- `.okayd/screenshots/`: a screenshot of each confirmed failure

`okayd ingest` then reads `verify-<issue>.json`: a criterion with a confirmed
refutation becomes **failed** with the evidence `refuted by verifier: <title>
(repro: .okayd/repro/<id>.json)`, whatever the tests said.

**Replay for free.** `okayd verify --replay-only [--url ...]` re-runs the saved
repro scripts with no model and no key. It exits 1 while a bug still
reproduces, so a fixed bug becomes a free regression check in CI.

**Deterministic detectors** run after every action, with no model: console
errors, uncaught exceptions, failed requests and HTTP 4xx/5xx, interactive
elements with no accessible name, horizontal overflow, and (opt in, same
origin, at most 20 links) broken links. They are confirmed the same way, by
reappearing on replay. A confirmed finding of severity 3 or more refutes the
criterion. Unnamed controls and overflow are severity 2: reported, not failing.

**Which account pays.** The Anthropic adapter needs an explicit key, either
`new AnthropicModel({ apiKey })` or `OKAYD_ANTHROPIC_API_KEY`. It never falls
back to `ANTHROPIC_API_KEY`, auth tokens or CLI profiles, so you choose which
account pays. Without a key, `okayd verify` exits 2. `@anthropic-ai/sdk` is an
optional peer dependency, loaded only when used: `npm i @anthropic-ai/sdk`. The
core stays dependency free, and any `ModelClient` works:

```ts
import { verify, AnthropicModel } from 'okayd/verify';
await verify({ baseUrl, model: new AnthropicModel({ apiKey }), dir: '.okayd' });
```

Status: the replay, detectors, agent loop and ledger integration are tested
against a scripted fake model. The Anthropic adapter is **not yet tested
against the live API**; its request and response shapes follow the SDK docs
and are checked against a fake client only. Known limits: broken-link checks
send no cookies; the key set is Enter, Tab, Escape, Backspace and arrows; one
tab, no file uploads or dialogs.

## Use with coding agents

`okayd mcp` runs an MCP server over stdio (no dependencies) so Claude Code,
Cursor and Codex can check the definition of done before they claim a task is
finished. For Claude Code, add this to `.mcp.json`:

```json
{ "mcpServers": { "okayd": { "command": "npx", "args": ["okayd", "mcp"] } } }
```

Tools (all take an optional `dir`, default `.okayd`, which must stay inside the
working directory):

- `okayd_criteria` lists criteria and the `[okayd:<issue>.<n>]` tag for each test title.
- `okayd_status` says "Done" or "Not done" and lists the unmet criteria. Call it before saying a task is finished.
- `okayd_ingest_junit` builds ledgers from a JUnit XML report.
- `okayd_add_criterion` appends a criterion. Agents can add criteria but not remove or edit them.

`skills/okayd/SKILL.md` is a Claude Code skill that tells agents to follow this
loop. Copy it to `.claude/skills/okayd/SKILL.md`.

## Roadmap

- [x] Proof files, ledger, merge gate
- [x] Ledger posted as one PR comment (updated on reruns) and in the job summary
- [x] Playwright Test reporter and JUnit ingest for any runner
- [x] Own Chrome driver (DevTools Protocol, no dependencies)
- [x] MCP server so coding agents check "done" through Okayd
- [x] CTRF ingest
- [x] Verifier agent that attacks each criterion on the preview deployment
- [ ] "Harden": commit passing verifier runs as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "Okayd" is a
trademark of its author; see [TRADEMARK.md](TRADEMARK.md). Contributions need a
signed CLA (see [CLA.md](CLA.md)). Official releases are published only by this
repo's release workflow, with npm provenance.
