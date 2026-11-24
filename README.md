# Okayd

**Your agent says it's done. Okayd proves it, criterion by criterion.**

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

## Roadmap

- [x] Proof files, ledger, merge gate
- [x] Ledger posted as one PR comment (updated on reruns) and in the job summary
- [x] Playwright Test reporter and JUnit ingest for any runner
- [ ] Verifier agent that attacks each criterion on the preview deployment
- [ ] "Harden": commit passing verifier runs as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "Okayd" is a
trademark of its author. Contributions need a signed CLA (see `CLA.md`).
