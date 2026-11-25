# Contributing to okproof

Anyone can contribute: fix a bug, improve a doc, add a runner recipe, or build a
feature. This page is everything you need, from first fork to merged PR.

## The short version

1. Open an issue (or comment on one) so we agree on the approach.
2. Fork, branch, make one focused change **with a test**.
3. Sign off your commits (`git commit -s`) and add the CLA phrase to your first PR.
4. Open the PR. The checks run on their own; fix anything red.
5. The maintainer reviews and merges when the acceptance checklist below is met.

## Before you start

- For anything bigger than a typo, open an issue first. Larger changes (new
  commands, file formats, anything touching the principles in [WHY.md](WHY.md))
  need a short written proposal, open for at least 5 days. The maintainer
  ([@rudr19](https://github.com/rudr19)) decides when there is no agreement and
  writes down why. The [Project section of the README](README.md#project) covers
  roles, compatibility and releases.
- Good first contributions: a tagging recipe for a runner you use, a real-world
  JUnit or CTRF fixture (in `test/fixtures`), a clearer error message, or a docs
  fix.
- Security problems: don't open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node 20 or later for the core, **Node 22 or later** for the browser
driver, the verifier and the probes. A local Chrome, Chromium or Edge is needed
only for the browser tests (they skip themselves when none is found).

```bash
git clone https://github.com/<you>/okproof
cd okproof
npm ci
npm test                      # builds, then runs every test
node scripts/pack-smoke.mjs   # checks the published package layout
```

Useful while working:

```bash
node dist/src/cli.js check                  # the CLI from your build
node dist/src/cli.js lint --tests test/     # okproof lints its own tests
npm run demo                                # the end-to-end demo (needs Chrome, Node 22)
```

Windows is supported and tested in CI. The repo uses LF line endings
(`.gitattributes` enforces this), so you don't need to change any git setting.

## What a good change looks like

- **One change per pull request.** Small PRs get merged faster.
- **A test for every behaviour change.** Write the failing test first when you
  can. Tests run the real CLI where it makes sense.
- **Zero runtime dependencies.** okproof ships with none, on purpose. Dev
  dependencies (TypeScript, the test tools) are fine; anything that ends up in
  `dependencies` needs a very good reason and an issue first.
- **Linear-time parsing.** Never build a `RegExp` from user input, and avoid
  nested quantifiers and lazy wildcards next to optional runs. CodeQL flags
  these, and so will the reviewer.
- **Keep the principle intact:** untested, flaky, skipped or assertion-less
  results never count as proven. That rule is the product.
- **Don't name other products** in code, docs, tests or release notes. Describe
  okproof by what it does.

## Commits and sign-off

Every commit must carry a `Signed-off-by` line, which certifies the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "Fix JUnit names that contain >"
```

You sign off **as yourself**, for work you wrote or have the right to submit. The
`DCO` check fails the PR if any commit is missing the line. To fix commits you
already made:

```bash
git rebase --signoff origin/main && git push --force-with-lease
```

Use the email you are happy to have public, or your GitHub `noreply` address
(Settings, Emails, "Keep my email addresses private").

## Contributor License Agreement

Every contributor agrees to the [CLA](CLA.md) once. Comment on your first pull
request, exactly:

> I have read the okproof CLA and I agree to it.

The CLA lets the project relicense or offer commercial terms later while you keep
the copyright in your contribution. Pull requests without it can't be merged.

## Acceptance checklist

A pull request is ready to merge when all of these are true. The PR template
repeats this list.

- [ ] It does one thing, and the description says what and why.
- [ ] There is a test that fails without the change and passes with it.
- [ ] `npm test` passes locally (Chrome-dependent tests may skip on your machine).
- [ ] `node scripts/pack-smoke.mjs` passes if you touched `package.json`, the CLI
      entry points or the exports.
- [ ] Every commit is signed off, and the CLA phrase is on your first PR.
- [ ] No new runtime dependency, no `RegExp` built from input, no secrets or
      tokens in code, tests or logs.
- [ ] Docs are updated: the README or `docs/` for user-visible changes, and an
      entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- [ ] The required checks are green (below) and every review conversation is
      resolved.

### Required checks

`main` is protected. A PR can merge only when these pass:

| Check | What it does |
| --- | --- |
| `CI / test` | Builds and tests on Ubuntu (Node 20 and 22) and Windows (Node 22) |
| `CodeQL` | Static security analysis |
| `DCO` | Every commit is signed off |
| `Dependency review` | No vulnerable or incompatible-license dependencies |
| `Action self-test` | The GitHub Action proves its own fixture |

If CodeQL reports an alert on your change, fix it in code first. If the code
does exactly what it is meant to (for example, `sync` writing the issue checklist
into the proof file), explain that in the PR and the maintainer will dismiss it
with a recorded reason.

## Pull request flow

1. Fork the repository and create a branch from `main`
   (`fix/<short-name>` or `feat/<short-name>`).
2. Push to your fork and open a pull request against `main`.
3. Pull requests from forks get a read-only token, so the PR comment and check run
   are skipped for you; the job summary still shows the result. That is expected.
4. Respond to review comments by pushing new commits (no need to squash; the
   maintainer squash-merges).
5. Once merged, your branch can be deleted.

## Using okproof on okproof

Changes that add or alter behaviour should be provable with okproof itself:
add a criterion to `.okproof/` in your PR, tag your test `[okproof:<id>]`, and
run `npx okproof lint --tests test/` to check that your tests really assert
something related to the criterion.

## Reviews and decisions

The maintainer reviews every PR. Expect questions about edge cases and about how
a heuristic could be evaded: okproof is built for a world where an AI agent may be
trying to make the gate pass without doing the work. Reviewers who are not the
maintainer are welcome; an approving review from another contributor is
appreciated and counts toward the project's code-review practice.

Be respectful: see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Trademark

The code is Apache-2.0. The name "okproof" and its logo are not covered by that
license. See [NOTICE](NOTICE) and [TRADEMARK.md](TRADEMARK.md).
