# Why okproof

## The idea: an auditor that tries to disprove "done"

Most tools confirm. An agent writes code and tests, CI goes green, and "done"
is accepted because nothing contradicted it. okproof inverts that. It is an
**auditor whose job is to falsify the claim "done"**: it looks for the
criterion that is not covered, the test that asserts nothing, the bug that
survives an attack. "Done" stands only if the audit fails to knock it down.
That is a different idea from a test runner, a browser agent, or a CI reporter,
and it works on top of all of them.

## How okproof thinks

1. **The criterion is the unit, not the test.** Green tests are not the
   question. "Does this acceptance criterion hold, and what is the evidence?" is.
   Every verdict is per criterion.
2. **Silence counts against you.** A criterion with no test, a flaky pass, a
   passing test with no assertion, or a test that is not tagged to the
   criterion is **not met**. Absence of failure is never proof.
3. **The auditor is never the author.** The agent that wrote the code does not
   grade it. An independent verifier attacks each criterion, and only a bug that
   reproduces on a model-free replay counts. A model's opinion never decides a
   verdict.
4. **Graded evidence, not pass/fail.** Evidence comes in levels (below).
   Today the ledger records the verdict and the evidence behind it; the full
   ladder is planned.
5. **Neutral across vendors.** okproof audits runs from any agent or test
   runner (Playwright, Vitest, Jest, pytest, Cypress, Go) through open
   JUnit XML and CTRF formats. It does not care which agent wrote the change.

### Evidence Levels (planned model)

| Level | Meaning | Status |
|---|---|---|
| E0 | Claimed: the agent or author says it is done | baseline, no evidence |
| E1 | A test tagged to the criterion passed | shipped (`met` requires at least this) |
| E2 | The passing test makes a real, relevant assertion | partly shipped: zero-assertion tests are `unproven` and `lint` flags them; relevance is not judged |
| E3 | Survived adversarial attack | partly shipped: the optional verifier plus model-free replay; the Anthropic adapter is untested against the live API |
| E4 | Verified in CI from the base branch, with a signed ledger | **roadmap, not built**: ledgers are unsigned today |

The ledger does not yet print a level per criterion; levels are the model the
roadmap builds toward.

## What is checked today

"Proves" in the tagline is the product promise. This is exactly what is checked:

"Proves" in the tagline is the product promise. This is exactly what is checked:

- **Tests tagged to criteria.** A criterion is `met` only if a test that claims
  it with `[okproof:<id>]` passed.
- **Assertion checks.** A tagged test that passed but made zero assertions does
  not make a criterion `met` (it is `unproven`). A flaky, skipped or timed-out
  test makes it `failed`. A criterion with no test is `untested`.
- **Replay-confirmed verifier refutations.** If you run the optional verifier, a
  criterion fails when a bug it found reproduces again on a model-free replay.

What it does not check: that a tagged test is a *good* test. An assertion that
is present but trivially true still passes. Review the tests; okproof narrows
what you have to take on trust, it does not remove it.

## The problem

Coding agents now write a large share of pull requests. Reviewing diffs no
longer keeps up, and an agent that writes its own tests mostly confirms its own
assumptions. Teams need a cheap, independent answer to one question: *did this
change do what the issue asked for?*

The agent-testing space is busy, and most projects answer a different question:
**"how does an agent use a browser?"** okproof answers: **"did this pull request
do what the issue asked for, and what is the evidence?"**

## What okproof is

1. **A contract.** Acceptance criteria live in a proof file in the repo,
   versioned and reviewed like code. Protect `.okproof/` with CODEOWNERS and the
   agent can't change the criteria without a reviewer; without that protection
   an agent with file access can edit them (the MCP server only lets it add
   criteria, but nothing stops a direct file edit).
2. **A ledger.** Test results are mapped to criteria. Each one is *met*,
   *failed*, *unproven* or *untested*, with evidence.
3. **A gate.** `okproof gate` exits 1 unless every criterion is met; make it a
   required check.
4. **An independent verifier** (optional). A separate agent tries to refute each
   criterion on a running app using okproof's own browser driver. Only
   refutations that reproduce on a model-free replay count. The Anthropic model
   adapter has **not been tested against the live API**; the replay, detectors
   and agent loop are tested against a scripted fake model.

Ledgers are plain JSON in your repo. They are **not signed**: anyone with write
access can hand-write one, and the gate only checks that ledger ids and text
match the proof file. Signed ledgers and a hosted proof page are
[roadmap](README.md#project), not shipped.

## The gaps okproof addresses

| Gap | What happens today | What okproof does |
|---|---|---|
| **No definition of done** | An agent says "done" when its own tests pass | Acceptance criteria live in a proof file in the repo, reviewable (and, with CODEOWNERS on `.okproof/`, protected) |
| **Green CI ≠ feature works** | CI says tests passed, not which requirement each one covers | Every criterion is met, failed, unproven or untested, with evidence |
| **Silence counts as success** | Skipped, missing or flaky tests still look green | Untested, flaky and assertion-less never count as met; the gate blocks |
| **The author grades itself** | The agent that wrote the code wrote the tests | An optional independent verifier tries to refute each criterion |
| **AI checks vanish** | PR-time AI reviews run once and leave nothing behind | Verifier findings that reproduce are saved as model-free repro scripts you can replay for free |
| **No durable record** | Results live in CI logs that expire | Ledgers are files in the repo (unsigned today; signed ledgers are roadmap) |
| **Lock-in** | Tests live inside a vendor's platform | Plain files, any runner, zero runtime dependencies |

## Principles

These decide every design question. A change that breaks one needs a very good
reason.

- **Silence is not proof.** Untested, skipped, flaky or assertion-less never counts as met.
- **The auditor is not the author.** Verification is independent of whatever wrote the code.
- **Deterministic verdicts.** A model may plan an attack, but a verdict comes
  from an assertion that passed or failed, never from a model's opinion.
- **You own everything.** Proof files, tests and ledgers are plain files in your
  repo. No lock-in, no required service.
- **Zero runtime dependencies.** okproof owns its chain: spec, ledger, driver,
  verifier and replay.
- **Works with what you have.** Playwright Test, JUnit XML from any runner, CTRF
  and okproof's own driver all feed the same ledger.
- **Cheap by default.** Model calls only where they add value. Replays cost nothing.

## How okproof stays useful

1. **Own the contract, not the browser.** Browser automation is a crowded,
   fast-moving commodity. okproof's center is the proof file and the ledger.
2. **Be the agent's definition of done.** An MCP server lets Claude Code, Cursor
   and Codex ask "which criteria are still unmet?" before they claim to be
   finished, and `okproof init --agents` sets that up in one command.
3. **Feed from everything.** Playwright Test, JUnit XML, CTRF and okproof's own
   driver produce the same ledger. Adoption needs no rewritten tests.

## Who it's for

Small product teams and solo builders who ship most of their code through
coding agents (Claude Code, Cursor, Codex and others) and want a checkable
answer before they merge.

## Non-goals

- Replacing your test runner or your browser automation library.
- A browser-agent platform or a hosted browser fleet.
- Visual diffing, load testing or monitoring.
- Grading pull requests with a model's opinion.

## How we measure success

- Real defects caught that the authoring agent missed.
- The share of verifier findings teams keep as permanent regression checks.
- Merges blocked for the right reason, never for flakiness.
