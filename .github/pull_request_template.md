## What this changes and why

## How it was tested

## Acceptance checklist (see CONTRIBUTING.md)

- [ ] One focused change, described above
- [ ] A test that fails without the change and passes with it
- [ ] `npm test` passes locally (Chrome tests may skip on my machine)
- [ ] `node scripts/pack-smoke.mjs` passes (if I touched package.json, the CLI or the exports)
- [ ] Every commit is signed off (`git commit -s`)
- [ ] First PR only: I have commented "I have read the okproof CLA and I agree to it."
- [ ] No new runtime dependency, no `RegExp` built from input, no secrets in code, tests or logs
- [ ] Docs updated, with an entry under "Unreleased" in CHANGELOG.md
- [ ] Untested, flaky or assertion-less results still never count as proven
