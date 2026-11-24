# Probato

**Your agent says it's done. Probato proves it, criterion by criterion.**

Probato checks a pull request against the acceptance criteria in its issue.
The criteria go in a proof file in the repo. Tests claim criteria by tag. The
run ends with a ledger that marks each criterion **met**, **failed** or
**untested**. Untested never counts as a pass, and neither does a flaky pass.

Probato is a plugin for the [e2e](https://github.com/e2e-inc/e2e) test
runner. It doesn't replace the runner.

## 1. Write a proof file

`.probato/142.md`:

```md
## #142 Pro upgrade
- [ ] A member can upgrade the workspace to Pro from Billing
- [ ] Invoice preview shows a prorated amount before confirming
- [ ] A viewer (non-admin) cannot see the upgrade button
```

Run `npx probato check` to print the tag for each criterion.

## 2. Claim criteria in tests

```ts
test('member upgrades to Pro [probato:142.1] [probato:142.2]', async ({ app, agent }) => {
  // ...
});
```

## 3. Add the reporter

```ts
// e2e.config.ts
import { probato } from '@probato/e2e';

export default {
  // ...
  reporters: ['list', probato()],
};
```

Each run writes `.probato/ledger-<issue>.json` and `.md`.
`npx probato gate` exits 1 unless every criterion is met. Use it as a required
CI check.

## Roadmap

- [x] Proof files, ledger, e2e reporter, merge gate
- [ ] GitHub check run with the ledger table and evidence links
- [ ] Verifier agent that attacks each criterion on the preview deployment
- [ ] "Harden": commit passing agent replays as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "Probato" is a
trademark of its author. Contributions need a signed CLA (see `CLA.md`).
