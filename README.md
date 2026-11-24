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

Both write `.okayd/ledger-<issue>.json` and `.md`. In GitHub Actions they also
write the ledger to the job summary and post it as one pull request comment
that reruns update. Give the job `pull-requests: write`, or pass
`{ github: false }` to turn this off.

## 4. Gate the merge

`npx okayd gate` exits 1 unless every criterion is met. Make it a required
check.

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
- [ ] Verifier agent that attacks each criterion on the preview deployment
- [ ] "Harden": commit passing verifier runs as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "Okayd" is a
trademark of its author; see [TRADEMARK.md](TRADEMARK.md). Contributions need a
signed CLA (see [CLA.md](CLA.md)). Official releases are published only by this
repo's release workflow, with npm provenance.
