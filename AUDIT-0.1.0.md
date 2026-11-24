# Audit of okproof 0.1.0: verdicts and fixes (branch fix/hardening)

An external audit of 0.1.0 found trust gaps. This file records, per gap, whether
the finding holds, where it lives (file:line at the 0.1.0 commit `46efed7`), what
this branch changed, and what remains. Gaps 3, 4 and 8 and the overclaim finding
are covered by feat/signals / fix/integrity / feat/adoption, not by this branch.
Gap 5 was not part of this branch's brief.

| Gap | Severity | Verdict | Fixed here |
| --- | --- | --- | --- |
| 1 Forged ledger | High | Confirmed | Yes (a, b, c, d) |
| 2 Proof-file swap | High | Partial: the swap is real, the sync heading check already existed | Yes |
| 6 Verifier false refutations | Medium | Confirmed | Yes |
| 7 Verifier cannot authenticate | Medium | Confirmed | Yes |
| 9 Peer dependency `"*"` | Medium | Confirmed | Yes |
| 10 Positional ids | Low | Confirmed | Yes |
| 3, 4, 8, overclaim | | covered by feat/signals / fix/integrity / feat/adoption | No |

## Gap 1 (High): forged ledger. Confirmed

- `src/gate.ts:79` reads `.okproof/ledger-<issue>.json` from disk and `:95` takes
  the verdict from its entries. `staleness()` only checks that the entries match
  the proof file's text. Nothing ties a ledger to a test run, so a hand-written
  all-`met` ledger passes the gate.
- `action.yml:130` ran `gate "$DIR"` with no results, so the Action trusted whatever
  was committed (`ingest` only ran when `results` was set, and a committed ledger
  survived either way).

Fixed:

- `okproof gate --results <file> [--format junit|ctrf]` (`src/trust.ts`
  `ledgersFromResults`, `runGate`) rebuilds every ledger in memory from the proof
  files and the results, and `src/gate.ts` (`GateOptions.ledgers`, lines 79-86 and
  120) ignores committed ledgers entirely, including the "ledger without proof
  file" check. Any applicable `verify-<n>.json` refutation is still applied (it can
  only fail a criterion).
- The Action (`action.yml` Gate step) runs `gate --results "$RESULTS"` when the
  `results` input is set, and emits `::warning::` saying the ledger is not bound to
  a test run when it is not.
- `okproof ingest` records `results_sha256` and `proof_sha256` in each ledger
  (`src/finalize.ts`, `src/ledger.ts`). `gate` without `--results` still passes a
  consistent ledger but prints `warning: ledger is not bound to a test run in this
  job` (`unboundLedgerWarnings`), and adds a line for each ledger with no
  `results_sha256`.
- `docs/trust.md` recommends not committing ledgers and shows the `.gitignore`
  lines (`.okproof/ledger-*`, `.okproof/verify-*.json`).

Limitations: the two hashes are informational. Without the results file `gate`
cannot check them, and a forger can write them too; only `--results` is a real
defence. `--results` is only as trustworthy as the file it points at: if the PR
commits `junit.xml` instead of producing it in the job, it can be forged. The MCP
tool `okproof_ingest_junit` calls `finalize` without a results hash. The tests
themselves are still authored by the PR (a test can assert something trivial);
`okproof lint` and the unproven verdict only catch tests with no assertions.

Tests: `test/audit-trust.test.ts` (forged ledger plus failing JUnit fails
`gate --results`; gate alone passes and warns; CTRF; hashes; Action wiring; docs).

## Gap 2 (High): proof-file swap. Partial

- The gate keys everything on the proof file's heading issue, not its filename
  (`src/gate.ts:62-76`), and `scripts/action-linked-issues.mjs:29` dropped every
  linked issue that had no proof file (the comment even said "skipped"). So
  renaming `142.md` and giving the new file an easy `## #<other>` heading removed
  #142 from sync and from the gate. Confirmed.
- `sync --check` already refused a heading that names a different issue than the
  file it is syncing (`src/sync.ts:193`, `:200`), and already compared criteria and
  title. That half of the finding does not hold; a test now pins it.

Fixed:

- `okproof gate --require-issues 142,143` (`src/trust.ts` `requiredIssueProblems`)
  fails with `#142 is linked by the pull request but there is no proof file` unless
  `.okproof/142.md` exists. The Action passes every issue linked in the PR body
  (or the `issue` input) via the new `required` output of
  `scripts/action-linked-issues.mjs`. `sync: write` creates the missing file;
  `require-linked: false` opts out for PRs that close issues okproof does not track.
- `okproof gate` fails any proof file whose heading issue differs from its filename
  (`proofNameProblems`).

Limitations: "Closes #N" is read from the PR body in the trigger event, so it sees
the body as of the last `opened`/`edited`/`synchronize` event; a PR that never
links its issue is not covered (nothing says which issue it is for). Full issue
URLs and cross-repo links are not recognised (unchanged from 0.1.0).

Tests: `test/audit-trust.test.ts` (swap scenario, per-issue requirement, heading
mismatch, `sync --check`, Action wiring).

## Gap 6 (Medium): verifier false refutations. Confirmed

- `src/verify/detectors.ts:156` reads the page-wide problem log, and
  `src/verify/run.ts:125` refutes on any confirmed finding with severity 3 or more.
  A third-party analytics 404, or an error already present when the page loaded,
  refuted a criterion that never touched it. (Findings already carried a per-step
  index, `Finding.step`, so no new capture was needed.)

Fixed (`src/verify/attribution.ts`, applied in `src/verify/run.ts`):

- A finding refutes only if it appeared after an action the agent took (step 1 or
  later). Step 0 is the initial page load: recorded, but capped at severity 2.
- Failed requests (and console errors that name a URL) to a different origin than
  `baseUrl` become severity 1 warnings. The finding's title is unchanged so replay
  matching still works, and downgraded findings are left out of the saved repro.
- `strictDetectors` (CLI `--strict-detectors`) restores the 0.1.0 behaviour.

Limitations: attribution is by step and origin, not causal. A same-origin
background poll that fails while the agent happens to act still counts. A
same-origin failure on first load can no longer refute by itself (the agent can
still report it with a failing assertion). Detector findings are deduplicated by
kind and title, so a step-0 finding that recurs later is not re-reported.

Tests: `test/audit-verify-attribution.test.ts` (real Chrome, local servers on two
origins), `test/attribution.test.ts` (pure).

## Gap 7 (Medium): verifier cannot authenticate. Confirmed

The verifier launches a fresh Chrome profile (`src/driver/launch.ts:63`) and had no
way to carry a session in, so anything behind a login was unreachable.

Fixed (`src/verify/auth.ts`, wired in `src/verify/run.ts` and `src/cli.ts`):

- `storageState` (`--storage-state`): Playwright-shaped JSON. Cookies via
  `Network.setCookies`; localStorage per origin via
  `Page.addScriptToEvaluateOnNewDocument`, which runs before the page's own scripts
  (once per tab, so the app's later writes are not overwritten).
- `cookies`, and `headers` (`--header 'Name: value'`, repeatable) via
  `Network.setExtraHTTPHeaders`.
- `login` (`--login script.mjs`): default export `async (page) => void`, run before
  each criterion. All of it is applied in the fresh replay browser too, so a finding
  that needs a session can still be confirmed.
- Secrets are never printed or saved: errors name a file or a position, and JSON
  parse errors (which quote their input) are replaced by a fixed message.

Limitations: extra headers go on every request the page makes, including to
third-party origins, so use test credentials. `--login` runs arbitrary user code
with okproof's driver `Page` (not Playwright's). Repro files do not store auth;
`verify --replay-only` needs the same flags again. The storage-state file itself
is a secret: keep it out of git.

Tests: `test/verify-auth.test.ts` (real Chrome with a cookie-gated server: control,
storage state, cookies, headers, login hook, authenticated replay, no secret in
logs or evidence, CLI errors).

## Gap 9 (Medium): peer dependency `"*"`. Confirmed

`package.json:71` declared `@anthropic-ai/sdk` as `"*"`. `npm view @anthropic-ai/sdk
version` reports 1.13.0, so it is now `>=1.0.0 <2.0.0` (in `package.json` and the
lockfile root entry); a future breaking major is not accepted silently. It stays
optional (`peerDependenciesMeta`) and is loaded lazily (`src/verify/model.ts:139`).
Documented in `docs/trust.md` and the README. Not tested against a real SDK install.

## Gap 10 (Low): positional ids. Confirmed

`src/proof.ts:40` builds ids from position, so inserting or removing a criterion
renumbers every later one and silently re-points tests. Fixed: `- [ ] {#login} A user
can sign in` is `142.login`; tag `[okproof:142.login]`; lines without `{#...}` stay
positional (`splitStableId`, `TAG` in `src/proof.ts`). Ids use `[a-z0-9-]`, need a
letter (so they cannot be mistaken for a position) and are unique per file;
violations throw. `sync` preserves `{#id}` when it rewrites and does not renumber
ids that have one (`src/sync.ts`); an id written in the issue body is adopted.
Lint's tag pattern and the MCP add-criterion message handle string ids. See
`docs/stable-ids.md`. Tests: `test/stable-ids.test.ts`.

Limitation: positional criteria still renumber when an earlier line is removed
(sync warns, as before).

## README claim to code

| README claim | Where it is enforced | Status after this branch |
| --- | --- | --- |
| "Untested never counts as a pass, and neither does a flaky pass" | `src/ledger.ts:52` `buildLedger` (every claiming test must be `passed`), `src/gate.ts` (verdict from entries) | Holds. With `--results` the ledger is rebuilt from this job's results. |
| A test that passes with zero assertions is not proof | `src/ledger.ts:48` `isWeak`; `src/lint.ts:408` `lintTests` | Holds; unknown assertion counts are not weak unless `--strict-assertions`. |
| "`okproof gate` exits 1 unless every criterion is met" | `src/trust.ts:157` `runGate`, `src/gate.ts` | Holds when run with `--results`. Without it the gate trusts committed ledgers and now warns. |
| The gate re-reads the proof files (criterion edits or deletions are stale) | `src/gate.ts:27` `staleness` | Holds; also fails heading/filename mismatch and missing required issues. |
| "Keep proof files in step with the issue" (`sync`, `sync --check`) | `src/sync.ts:183` `syncProofFile` | Holds; heading mismatch already threw. Now stable-id aware. |
| Linked issues are checked by the Action | `scripts/action-linked-issues.mjs`, `action.yml` | Now requires a proof file for each linked issue (previously skipped). |
| "A verifier refutation is confirmed by replaying it with no model" | `src/verify/run.ts:111` (`confirmed`), `src/verify/replay.ts` | Holds; detector findings are now attributed (gap 6) before they can refute. |
| The verifier can test an app | `src/verify/run.ts`, `src/verify/auth.ts` | Public pages as before; authenticated pages now supported. |
| "ingest picks the format from the file" | `src/trust.ts:23` `parseResults` | Holds (shared by `ingest` and `gate --results`). |
| A pass after a retry is flaky (Playwright) | `src/playwright.ts:65` | Holds. |
| "No runtime dependencies" | `package.json` (no `dependencies`; optional peer only) | Holds; peer range now pinned. |
| Core runs on Node 20, driver and verifier need Node 22 | `package.json` `engines`; `src/driver/cdp.ts:34` | Holds. |
