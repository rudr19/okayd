# okproof vision

## Mission

**Make "done" mean proven.** When a coding agent (or a person) says a change is
finished, okproof shows, criterion by criterion, whether the evidence agrees.

## The problem

Coding agents now write a large share of pull requests. Reviewing diffs no
longer keeps up, and an agent that writes its own tests mostly confirms its own
assumptions. Teams need a cheap, independent answer to one question: *did this
change do what the issue asked for?*

## What okproof is

1. **A contract.** Acceptance criteria live in a proof file in the repo,
   versioned and reviewed like code. The agent can't quietly weaken them.
2. **A ledger.** Test results are mapped to criteria. Each one is *met*,
   *failed* or *untested*, with evidence.
3. **A gate.** A pull request merges only when every criterion is met.
4. **An independent verifier** (in progress). A separate agent, not the one that
   wrote the code, tries to prove each criterion false on the preview
   deployment, using okproof's own browser driver. Passing runs replay without a
   model, so they become free, repeatable regression tests.

## Principles

These decide every design question. A change that breaks one needs a very good
reason.

- **Silence is not proof.** Untested, skipped or flaky never counts as met.
- **The auditor is not the author.** Verification is independent of whatever
  wrote the code.
- **Deterministic verdicts.** A model may plan an attack, but a verdict comes
  from an assertion that passed or failed, never from a model's opinion.
- **You own everything.** Proof files, tests and ledgers are plain files in your
  repo. No lock-in, no required service.
- **Built from scratch, zero runtime dependencies.** okproof owns its full chain:
  spec, ledger, driver, verifier and replay.
- **Works with what you have.** Playwright Test, JUnit XML from any runner, and
  okproof's own driver all feed the same ledger.
- **Cheap by default.** Model calls only where they add value. Replays cost
  nothing.

## Who it's for

Small product teams and solo builders who ship most of their code through
coding agents (Claude Code, Cursor, Codex and others) and want proof before they
merge.

## Non-goals

- Replacing your test runner or your browser automation library.
- A browser-agent platform or a hosted browser fleet.
- Visual diffing, load testing or monitoring.
- Grading pull requests with a model's opinion.

## How we measure success

- Real defects caught that the authoring agent missed.
- The share of verifier runs teams keep as permanent tests.
- Merges blocked for the right reason, never for flakiness.

See [ROADMAP.md](ROADMAP.md) for what comes next and
[GOVERNANCE.md](GOVERNANCE.md) for how decisions are made.
