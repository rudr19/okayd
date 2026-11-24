# Okayd

**Your agent says it's done. Okayd proves it, criterion by criterion.**

> Browser agents act. Test frameworks run. CI reports. **Okayd proves.**
> [Why Okayd](WHY-OKAYD.md) · [Vision](VISION.md) · [Roadmap](ROADMAP.md) · [Governance](GOVERNANCE.md) · [Security](SECURITY.md)

Okayd checks a pull request against the acceptance criteria in its issue.
The criteria go in a proof file in the repo. Tests claim criteria by tag. The
run ends with a ledger that marks each criterion **met**, **failed** or
**untested**. Untested never counts as a pass, and neither does a flaky pass.

Okayd is a plugin for the [e2e](https://github.com/e2e-inc/e2e) test
runner. It doesn't replace the runner.

## 1. Write a proof file

`.okayd/142.md`:

```md
## #142 Pro upgrade
- [ ] A member can upgrade the workspace to Pro from Billing
- [ ] Invoice preview shows a prorated amount before confirming
- [ ] A viewer (non-admin) cannot see the upgrade button
```

Run `npx okayd check` to print the tag for each criterion.

## 2. Claim criteria in tests

```ts
test('member upgrades to Pro [okayd:142.1] [okayd:142.2]', async ({ app, agent }) => {
  // ...
});
```

## 3. Add the reporter

```ts
// e2e.config.ts
import { okayd } from 'okayd';

export default {
  // ...
  reporters: ['list', okayd()],
};
```

Each run writes `.okayd/ledger-<issue>.json` and `.md`. In GitHub Actions it also
writes the ledger to the job summary and posts it as one pull request comment
that reruns update. Give the job `pull-requests: write`, or pass
`okayd({ github: false })` to turn this off.
`npx okayd gate` exits 1 unless every criterion is met. Use it as a required
CI check.

## Roadmap

- [x] Proof files, ledger, e2e reporter, merge gate
- [x] Ledger posted as one PR comment (updated on reruns) and in the job summary
- [ ] Verifier agent that attacks each criterion on the preview deployment
- [ ] "Harden": commit passing agent replays as tests linked to criteria
- [ ] OIDC-signed ledgers on a hosted proof page

## License

Apache-2.0 for this package. Copyright © 2026 Rudra Kumar Pandey. "Okayd" is a
trademark of its author; see [TRADEMARK.md](TRADEMARK.md). Contributions need a
signed CLA (see [CLA.md](CLA.md)). Official releases are published only by this
repo's release workflow, with npm provenance.
