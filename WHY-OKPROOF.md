# Why okproof

The agent-testing space is busy. Most projects answer **"how does an agent use a
browser?"** okproof answers a different question that nobody owns yet:

> **"Did this pull request do what the issue asked for, and can you prove it?"**

## The landscape (November 2026)

Star counts from the GitHub API, 24 November 2026.

| Group | Projects | What they do | What they don't do |
|---|---|---|---|
| **Browser agents** | browser-use (122K), Stagehand (26K), Skyvern (24K), Steel (8K) | Let an agent operate websites | Know what "correct" means for your app |
| **Agent browser tools / MCP** | chrome-devtools-mcp (59K), agent-browser (54K), playwright-mcp (40K), Lightpanda (43K) | Give coding agents eyes and hands in a browser | Keep any record of what was proven, or block a merge |
| **Test frameworks** | Playwright (101K) | Run tests a person wrote | Link a test to the requirement it proves |
| **Natural-language / agentic E2E** | Midscene (16K), e2e (14K), Shortest (6K) | Write or run tests in plain language | Treat the spec as a contract; refuse "untested" as a pass |
| **CI engines and reporting** | act (73K), Dagger (17K), CTRF reporter | Run pipelines, show test results | Say whether the *feature* is done |

All of these are good at what they do. okproof sits on top of them, not against
them.

## The gaps okproof fills

| Gap | What happens today | What okproof does |
|---|---|---|
| **No definition of done** | An agent says "done" when its own tests pass | Acceptance criteria live in a proof file the agent can't quietly weaken |
| **Green CI ≠ feature works** | CI says tests passed, not which requirement each one proves | Every criterion is met, failed or untested, with evidence |
| **Silence counts as success** | Skipped, missing or flaky tests still look green | Untested and flaky never count as met; the gate blocks |
| **The author grades itself** | The agent that wrote the code wrote the tests | An independent verifier attacks each criterion (in progress) |
| **AI checks vanish** | PR-time AI reviews run once and leave nothing behind | Passing verifier runs replay without a model and become permanent tests |
| **No trustworthy record** | Results live in CI logs that expire | Ledgers are files in the repo, signed with GitHub OIDC (planned) |
| **Lock-in** | Tests live inside a vendor's platform | Plain files, any runner, zero runtime dependencies |

## How okproof stays one step ahead

1. **Own the contract, not the browser.** Browser automation is a crowded,
   fast-moving commodity. okproof's center is the proof file and the ledger:
   a format any tool can produce results for.
2. **Be the agent's definition of done.** An MCP server lets Claude Code,
   Cursor and Codex ask okproof "which criteria are still unmet?" *before* they
   claim to be finished. The agents those 50K-star tools power become okproof's
   users.
3. **Feed from everything.** Playwright Test, JUnit XML from any runner, CTRF,
   and okproof's own driver all produce the same ledger. Teams adopt okproof without
   rewriting a single test.
4. **Independent and deterministic.** The verifier is never the author, and a
   verdict always comes from a real assertion, never a model's opinion.
5. **Built from scratch, fully owned.** okproof's chain (spec, ledger, driver,
   verifier, replay) has zero runtime dependencies and no dependency on any
   competitor.
6. **Proof you can verify.** Signed ledgers and npm provenance mean anyone can
   check who produced a result and from which commit.

## One-line comparison

- Browser agents **act**. Test frameworks **run**. CI **reports**.
- **okproof proves**, criterion by criterion, and blocks the merge until it can.

See [VISION.md](VISION.md) for the principles and [ROADMAP.md](ROADMAP.md) for
what's next.
