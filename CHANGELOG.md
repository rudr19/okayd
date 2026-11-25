# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `okproof diff --base <ref> --test <command> --results <file>`: differential proof. Runs the PR's tests on the merge base and on HEAD in temporary git worktrees (zero tokens, no model). A criterion is `proven-by-change`, `not-differential` (passes on both: not met, unless the criterion carries the `pre` token, or `--allow-preexisting`), `regressed` or `failing`. Writes `.okproof/diff-<issue>.json`; the gate and ledger honour it.
- `okproof revert-check`: reverts each changed source file in a worktree and records which criteria's tests notice; a criterion whose tests stay green is `uncovered` (not met, unless `--allow-uncovered`). Writes `.okproof/revert-<issue>.json`.
- Action inputs `differential` (`off`/`on`) and `test-command`. Needs `fetch-depth: 0`.
- `okproof gate --allow-preexisting --allow-uncovered`.
- Evidence levels E0 to E4 (README, "Evidence levels"). Ledger entries carry `level`, `required` and `gaps`; a criterion is met only when its level reaches the level it requires. A criterion line can require a level with a `{E3}` token, combinable with `{#id}` and `pre` (`{#pay E3 pre}`); the default is E2, set with `--min-level` or the Action's `min-level` input. The ledger table and PR comment gain a Level column (`E2/E3 ▰▰▱`), gate messages say what evidence is missing, and `okproof_status` shows levels and the next step to raise each. New verdict `insufficient`. E3 reads optional `verify-<n>.json`, `diff-<n>.json` and `revert-<n>.json`; E4 is attested only by `gate --results` with `--proof-matches-base` (the Action passes it when `.okproof/` matches the base branch).
- Verifier cost: snapshot diffs after the first view (full snapshot at least every fifth view), a per-criterion token budget (`--budget-tokens`, default 20000, 0 for none; an over-budget run is `inconclusive`), tokens per criterion in `verify-<n>.json` and the CLI output.

- Zero-token probes: `okproof verify` now runs deterministic probes first (persistence, back-forward, double-submit, narrow-viewport, keyboard, offline, hostile-input), each replay-confirmed with no model, and calls the model only for criteria no probe refuted. `--probes-only` runs just the probes and needs no key; `--no-probes` restores model-only behaviour. See the README section "Zero-token probes".
- Driver: `page.goto(url, { waitUntil: 'load' | 'domcontentloaded' | 'networkidle', timeoutMs })` and `okproof verify --wait-until`. A page that does not finish loading fails with the event it waited for and what to try instead. `page.doubleClick(ref)` and `page.requests()` were added too.

### Changed

- With `--lint`, a passing test that lint calls "possibly unrelated" now holds its criterion at E1, which fails the default E2 requirement (it was advisory before). Use `{E1}` on a criterion, `--min-level E1`, or fix the test.

## [0.2.0] - 2026-11-24

### Added

- `okproof init [--issue N --title T] [--runner r] [--agents] [--workflow] [--yes]`: one-step setup of `.okproof/`, a CI workflow, and agent files (AGENTS.md, CLAUDE.md, skill, `.mcp.json`). Never overwrites.
- Lint findings feed the ledger: `okproof ingest <results> --lint [path|glob]` and `okproof gate --results <file> --lint [path|glob]` mark tests lint finds weak (no or trivial assertions) as asserting nothing, so their criterion is `unproven` even when the runner reports no assertion counts. Matched by tag and title. The Action has a `lint` input (`auto`, a path or glob, or `off`).
- JUnit: a passing `<testcase>` with `<flakyFailure>`, `<flakyError>`, `<rerunFailure>`, `<rerunError>` or a non-zero `rerun` property is `flaky`, never met.
- `okproof lint` flags tagged tests whose only assertions are trivial (`expect(true).toBe(true)`, `assert True`, ...) as weak, and warns when a tagged test never mentions any key word of its criterion ("possibly unrelated"; advisory, `--strict-relevance` makes it fail). Also in `lintTests()` and the new `okproof_lint` MCP tool.
- `okproof gate --results <file>`: rebuild ledgers in memory from this job's test results and ignore committed ones; `--require-issues 142,143`; results and proof sha256 recorded in ledgers. See docs/trust.md.
- Linked-issue enforcement in the Action (`require-linked`): a PR that closes an issue with no proof file fails the gate.
- Verifier: per-detector attribution of findings (`--strict-detectors` restores page-global attribution); authentication with `--storage-state`, `--header` and `--login`.
- Stable criterion ids, `{#id}` prefix on a criterion line (docs/stable-ids.md).
- Property-based tests (fast-check, a dev dependency only) for the parsers, issue sync, lint scanner and ledger invariants.
- Release workflow attaches the packed tarball and its build-provenance attestation bundle (`okproof-<version>.intoto.jsonl`) to the GitHub release.

### Changed

- The gate is the single source of truth: the Action `proven` output, the PR comment headline and MCP `okproof_status` all use `evaluateGate`. GitHub posting is more robust. `verify-<issue>.json` records a `criteriaHash`, and stale verifier results fail the gate.
- Relevance check treats regex and template literals in the test body as text. The lint scanner tells a regex from a division by the preceding token.
- `--tests` globs are matched by a plain string matcher (no regular expression built from the pattern), with a 512 character limit.
- `@anthropic-ai/sdk` peer dependency is pinned to `>=1.0.0 <2.0.0`.
- Docs say precisely what is checked; signed ledgers and the hosted proof page are marked roadmap. WHY.md replaces the vision and rationale documents; governance and roadmap moved into the README "Project" section and CONTRIBUTING.md. CODEOWNERS protection for `.okproof/` is documented. README rewritten around a quick start.

## [0.1.0] - 2026-11-24

First release. okproof checks a pull request against the acceptance criteria in
its issue and ends with a ledger that marks each criterion met, failed or
untested.

### Added
- Proof files (`.okproof/<issue>.md`) that hold the acceptance criteria, and tests
  that claim criteria by `[okproof:<issue>.<n>]` tag. A ledger
  (`.okproof/ledger-<issue>.json` and `.md`) marks each criterion met, failed or
  untested. Untested and flaky passes never count as met.
- `okproof gate`: exits 1 unless every proof file has a fresh, fully met ledger.
  The proof file is the source of truth. A criterion added, removed or edited
  after the ledger was written makes it stale, a missing or invalid ledger
  fails, and an empty directory fails unless `--allow-empty` is passed.
- `okproof check [dir]`: validates proof files and prints each criterion's tag.
  `check --issue-body <file> [--issue N]` fails when the issue's checkboxes and
  the proof file disagree, in either direction.
- Ledger posted as one pull request comment that reruns update, and written to
  the job summary, in GitHub Actions. `OKPROOF_NO_COMMENT=1` turns this off; a
  read-only fork token is skipped, not fatal.
- Playwright Test reporter (`okproof/playwright`). A pass that needs a retry is
  flaky, and a recorded trace is linked as evidence.
- `okproof ingest` for JUnit XML (Jest, Vitest, pytest, JUnit, Cypress, Go and
  more) and CTRF JSON, with format auto-detection and `--format junit|ctrf`.
- Own Chrome driver (`okproof/driver`): talks the DevTools Protocol directly over
  Node's built-in WebSocket, returns short accessibility-tree snapshots, and
  acts by ref. Honours `OKPROOF_CHROME`. Needs Node 22.
- MCP server (`okproof mcp`, stdio) with `okproof_criteria`, `okproof_status`,
  `okproof_ingest_junit` and `okproof_add_criterion`, so coding agents check the
  definition of done before claiming a task is finished. Agents can add
  criteria but not remove or edit them. Ships `skills/okproof/SKILL.md`, a Claude
  Code skill for that loop.
- Composite GitHub Action (`rudr19/okproof`) with `results`, `dir`, `gate`,
  `comment`, `node-version` and `github-token` inputs, and `proven` and
  `summary` outputs.
- Verifier (`okproof verify --url <app>`, `okproof/verify`): an adversarial agent
  that tries to prove each criterion false through the driver. Every action is
  recorded as JSON, and a violation counts only if its assertion fails again
  when replayed with no model in a fresh browser; unconfirmed claims are
  listed and do not fail the criterion. Writes `verify-<issue>.json`,
  model-free repro scripts and screenshots, and `okproof ingest` turns a
  confirmed refutation into a failed criterion. `--replay-only` reruns saved
  repros with no model and no key, and exits 1 while a bug still reproduces.
- Model-free detectors that run after every action: console errors, uncaught
  exceptions, failed requests and HTTP 4xx/5xx, unnamed interactive elements,
  horizontal overflow and (opt in) broken links, confirmed by replay.
  Severity 3 or more refutes a criterion.
- Anthropic model adapter that needs an explicit key (`OKPROOF_ANTHROPIC_API_KEY`
  or `new AnthropicModel({ apiKey })`) and never falls back to other
  credentials. `@anthropic-ai/sdk` is an optional peer dependency, and any
  `ModelClient` can be used instead.
- Project vision, roadmap, governance, trademark policy and CLA.
- `npm run smoke`: packs the package, extracts the tarball and runs the packed
  CLI and every export path, in CI on Node 22.

### Security
- Supply chain: all GitHub Actions pinned by commit SHA, CodeQL, OpenSSF
  Scorecard, dependency review, DCO check, Dependabot, and zero runtime
  dependencies.
- Releases are published only by the release workflow, with an npm provenance
  attestation and an attested tarball.
- Gate bypasses closed: the gate reads proof files, not ledgers, as the source
  of truth, with regression tests for the bypass cases.
- Linear-time regexes for JUnit attributes and snapshot refs (CodeQL
  polynomial-ReDoS), and race-free proof reads in the MCP server.
- MCP tools keep `dir` inside the working directory.

### Known limits
- The Anthropic adapter has been tested against a fake client only, not the
  live API.
- The driver and verifier need Node 22 or later; the rest runs on Node 20.
- Ledger and proof file formats are not yet documented as a stable schema.
