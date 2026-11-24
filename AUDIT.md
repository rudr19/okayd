# Okayd audit

Audited branch `fix/audit`, which includes the Playwright reporter, JUnit and
CTRF ingest, the Chrome driver, the MCP server, the GitHub Action and the
verifier. The external brief was written against the old e2e-plugin README; the
code has moved on, so every verdict below is against this code.

Method: read every file in `src/`, `test/`, `scripts/`, `.github/`,
`action.yml` and all top-level docs. No model API was called and no credentials
were read. `npm pack` and the packed CLI were run locally; npm was queried
read-only.

## Gaps

| # | Sev | Gap | Status | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | H | Overclaim "proves" / agent framing | PARTIAL | `src/verify/run.ts`, `src/verify/replay.ts`: findings count only if an assertion fails again on model-free replay, so the verifier claim is backed. Still overclaiming: README.md:3 "Okayd proves" while the `Anthropic` adapter is untested against the live API (README.md:197); WHY-OKAYD.md:27 and VISION.md:18 "the agent can't quietly weaken" the proof file, but nothing stops an agent editing `.okayd/*.md` (only `okayd_add_criterion`-only in MCP, `src/mcp/tools.ts`); WHY-OKAYD.md:52 and README.md:231 "signed ledgers" are roadmap. | Planned: reword to "checks and records", say "tests tagged to criteria" instead of "proves"; protect `.okayd/` with CODEOWNERS and run `check --issue-body` in the Action (see 3). |
| 2 | H | A tag is a claim, not verification | CONFIRMED (partly mitigated) | `src/proof.ts:50` `claimedCriteria` only regex-matches the title; `src/ledger.ts:33-34` any test with the tag that passes makes the criterion `met`, even `expect(true)`. Mitigation that exists: confirmed verifier refutation fails a criterion regardless of tests (`src/verify/ledger.ts` `applyVerifyFile`, `src/finalize.ts:36-37`). The verifier file is optional and is not checked for staleness. | Assertion check ("unproven" verdict) is being added in another branch: not implemented here, by instruction. |
| 3 | H | Criteria drift: proof file vs GitHub issue body | CONFIRMED, now detectable | Before: nothing read the issue body. | Done: `okayd check [dir] --issue-body <file> [--issue N]` (`src/cli.ts`, `compareToIssueBody` and `issueBodyCriteria` in `src/proof.ts`) compares checkbox lines, reports added and missing criteria, exit 1 on mismatch, no network. Tests: `test/audit-drift.test.ts`. Planned: have the Action fetch the issue body and call it (needs a network step and `action.yml`, outside this branch's scope). |
| 4a | H | Delete a criterion, old ledger still passes | CONFIRMED, fixed | Before: `gate` read only `ledger.proven` (old `src/cli.ts` gate branch). Test failed before the fix (commit 07a0489). | Done: `src/gate.ts` `staleness()` compares ledger ids and text with the proof file; mismatch fails as STALE with a re-run message. |
| 4b | H | No proof file / no `.okayd` | CONFIRMED, fixed | Before: missing dir threw ENOENT and exit 2 with a stack-like message; an empty dir exited 1 only via "No ledgers" (and `action-outputs.mjs` is separate). | Done: `evaluateGate` fails with "nothing to prove" unless `--allow-empty`. |
| 4c | H | Proof file present, no ledger | PARTIAL, fixed | Before: with zero ledgers it failed; with one ledger and a second proof file lacking one, it passed. | Done: every proof file needs its own ledger (`src/gate.ts`, "has no ledger"); orphan ledgers (proof deleted) also fail. |
| 4d | H | Ledger stale vs proof file | CONFIRMED, fixed | Same cause as 4a. Also `ledger.proven` was trusted even if entries were not `met`. | Done: verdict is recomputed from entries; `proven` is ignored. |
| 5 | M | Single-runner coupling | REFUTED | Playwright reporter `src/playwright.ts`, JUnit `src/junit.ts`, CTRF `src/ctrf.ts`, own driver `src/driver`, all feed `finalize` (`src/finalize.ts`). No e2e adapter remains. | n/a |
| 6 | M | How is flaky detected | PARTIAL | Playwright: `src/playwright.ts:42` pass with `retry > 0` becomes `flaky` (last result per test wins). CTRF: `src/ctrf.ts:24` `flaky === true` or `retries > 0`. JUnit: no detection at all (`src/junit.ts:30-32` only sees `<skipped>`, `<failure>`, `<error>`); Surefire-style `<flakyFailure>`, `<rerunFailure>` children do not match `<(failure\|error)\b` and the case reads as `passed`. Playwright's own JUnit reporter most likely emits retried-then-passed tests as plain passes (unverified), so the README line "any runner via JUnit" loses the flaky rule. `ledger.ts:35` treats only `passed` as met, so `flaky` fails correctly once detected. | Planned: parse `flakyFailure`, `flakyError`, `rerunFailure`, `rerunError` as `flaky` in `src/junit.ts`; document that JUnit from Playwright needs the reporter or CTRF for flaky detection. |
| 7 | M | Fork PRs: read-only token | PARTIAL | `src/github.ts:114-118` a 403 on POST/PATCH returns `skipped`, tested (`test/github.test.ts:69`). But network errors are not caught: `fetchImpl` throws at `src/github.ts:106,112-113` and `appendFile` at `:83` propagate through `finalize`, so `ingest` exits 2 after the ledger is written. Also only the first 100 comments are scanned (`:106`), so on a busy PR the marker comment can be missed and a second comment posted. | Planned: wrap publish in try/catch inside `publishToGitHub` and paginate. Not done: `src/github.ts` is outside this branch's file scope. |
| 8 | M | Distribution | PARTIAL | `package.json`: name `okayd`, `bin.okayd`, `files` (dist/src, README, LICENSE, skills), `exports`; `.github/workflows/release.yml` publishes with provenance on a release whose tag matches the version. `npm pack` gives `okayd-0.0.1.tgz`, 58 files, 50.9 kB; extracting it and running `node package/dist/src/cli.js check` and `gate` from a temp project worked, and `import('./dist/src/index.js')` loads 42 exports. Not yet published: `npm view okayd` is 404. Not covered: `npx okayd` has never been exercised against a registry install; no `npm pack` smoke test in CI; `engines` says Node >=20 but the driver needs Node 22 (`src/driver/cdp.ts:32`, README.md:123) while CI runs 20 and 22. `main`/`types` point at `dist/src/index.js`, fine. | Planned: add a CI step that packs, installs the tarball in a temp dir and runs `okayd check`; state Node 22 for the driver and verifier in `engines` notes. Publishing needs the maintainer. |
| 9 | M | Name collision | PARTIAL | Read-only: `npm view okayd` and `npm view @okayd/e2e` both return E404, so on the registry both names are free today. Risk is the other direction: an `e2e` project exists (the tooling in this environment) and the old README called Okayd an e2e plugin, so search results and the old scope may confuse. Claim `okayd` and the `@okayd` scope on npm before announcing. | Planned (maintainer): reserve the names; TRADEMARK.md already covers forks. |
| 10 | L | Opinion: pre-1.0 file formats are public interfaces | n/a | GOVERNANCE.md:"Compatibility" promises stability of proof file and ledger JSON. This audit's gate depends on ledger `entries[].id/text`, so they are now load-bearing. | Document the ledger schema before 1.0. |
| 11 | L | Opinion: scope | n/a | The package now bundles a reporter, driver, MCP server, verifier and Action. Breadth is fine while it all feeds one ledger, but each surface is another place the "proven" bit can be forged. | Keep one gate function (`src/gate.ts`) as the single source of truth and make every surface call it. |

## Other findings

| Finding | Evidence | Status |
|---|---|---|
| The Action `proven` output and the MCP `okayd_status` still trust ledgers | `scripts/action-outputs.mjs` reads `ledger.proven`; `src/mcp/tools.ts:204-214` only warns when a proof file is newer than its ledger and matches entries by id, not text | Open. With `gate: false` the `proven` output can still be true for a stale ledger. Both should call `evaluateGate`. Outside this branch's file scope. |
| Ledgers are unsigned plain JSON | `src/ledger.ts`; anyone with repo write access can hand-write a `met` ledger | Open by design until OIDC signing (ROADMAP "Later"). The gate now at least requires ids and text to match the proof file. |
| `verify-<issue>.json` is not tied to the proof file | `src/verify/ledger.ts` `applyVerifyFile` ignores unknown ids and never checks text; deleting the file removes a refutation silently | Open. |
| Any `.md` in `.okayd` is parsed as a proof file | `src/finalize.ts:30-32`, `src/gate.ts` | A stray README makes gate, ingest and check fail loudly rather than pass. Acceptable. |
| Two proof files with the same issue number | previously the later ledger overwrote the earlier | Fixed in the gate (fails); `finalize` still overwrites. |

## README claims vs code

| README claim | Implemented in |
|---|---|
| Proof file with `- [ ]` criteria, ids `<issue>.<n>` | `src/proof.ts` |
| `okayd check` prints tags | `src/cli.ts` check branch |
| Tests claim criteria by `[okayd:N.M]` tag | `src/proof.ts` `claimedCriteria` |
| Ledger met / failed / untested; untested is not a pass | `src/ledger.ts:28-42` |
| Flaky pass is not proven | Playwright `src/playwright.ts:42`, CTRF `src/ctrf.ts:24`; JUnit: missing (gap 6) |
| Playwright reporter, trace as evidence | `src/playwright.ts` |
| JUnit ingest for any runner | `src/junit.ts` |
| CTRF ingest, `--format`, auto-detect | `src/ctrf.ts`, `src/cli.ts` ingest branch |
| Ledger written as `.json` and `.md` | `src/finalize.ts:36-40` |
| Job summary and one updating PR comment | `src/github.ts` (needs `pull-requests: write`) |
| `{ github: false }` to turn off | `src/finalize.ts:15`, `src/playwright.ts` options |
| `okayd gate` exits 1 unless every criterion met | `src/gate.ts`, now checked against proof files |
| GitHub Action with inputs and outputs | `action.yml`, `scripts/action-outputs.mjs` |
| `comment: false` and `OKAYD_NO_COMMENT=1` | `action.yml`, `src/cli.ts` ingest branch |
| `v0` moving tag | missing: nothing in `.github/workflows` moves it (release.yml only publishes to npm) |
| Chrome driver, no dependencies, `OKAYD_CHROME` | `src/driver/` |
| `okayd verify` adversarial agent | `src/verify/agent.ts`, `src/verify/run.ts` |
| Actions recorded, replay in a fresh browser decides | `src/verify/replay.ts`, `src/verify/run.ts` |
| Writes `verify-<issue>.json`, `repro/`, `screenshots/` | `src/verify/run.ts` |
| Ingest folds in refutations | `src/verify/ledger.ts`, `src/finalize.ts:36-37` |
| `--replay-only` needs no key, exits 1 while bug reproduces | `src/cli.ts` runVerify |
| Deterministic detectors, severity 3 refutes | `src/verify/detectors.ts` (`REFUTE_SEVERITY = 3`) |
| Explicit key only, `OKAYD_ANTHROPIC_API_KEY` | `src/verify/model.ts`; adapter untested against the live API (README says so) |
| MCP server and four tools | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| Agents can add but not remove or edit criteria | `okayd_add_criterion` only; a human or agent with file access can still edit the file |
| `skills/okayd/SKILL.md` | `skills/okayd/` |
| "Harden" and OIDC-signed ledgers | roadmap, not implemented |
| `okayd check --issue-body` (new) | `src/cli.ts`, `src/proof.ts` |
| `okayd gate --allow-empty` (new) | `src/cli.ts`, `src/gate.ts` |
| Releases published only by the release workflow with provenance | `.github/workflows/release.yml` (never run yet: package unpublished) |

## Prioritized fixes still open

1. Make `scripts/action-outputs.mjs` and MCP `okayd_status` call the shared
   gate logic (`evaluateGate`) so no surface trusts `ledger.proven`.
2. Add the assertion check ("unproven" verdict, other branch) so a tagged empty
   test is not `met`.
3. Wire `check --issue-body` into the Action (fetch the body with the token) and
   protect `.okayd/` with CODEOWNERS so the agent cannot weaken criteria alone.
4. Catch network and file errors in `publishToGitHub`, paginate comment search.
5. Detect flaky in JUnit (`flakyFailure`, `rerunFailure`, and so on).
6. Tie `verify-<issue>.json` to the proof file (reject stale or unknown ids).
7. Reword overclaims: "proves" and "agent can't weaken" until the above land;
   keep "signed" as roadmap.
8. CI pack smoke test; claim the `okayd` npm name and `@okayd` scope; fix the
   Node 20 vs 22 statement; add a job that moves the `v0` tag.
9. Export `evaluateGate` and `compareToIssueBody` from `src/index.ts`.
