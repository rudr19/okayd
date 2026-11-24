# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
