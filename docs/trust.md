# What the gate trusts

okproof proves a pull request against its acceptance criteria. That only means
something if the evidence cannot be written by the author of the pull request.
This page says what the merge gate believes, and what it does not.

## Ledgers are a cache, not evidence

`okproof ingest` writes `.okproof/ledger-<issue>.json`. A committed ledger is
just a file. Anyone who can push can hand-write one that says every criterion is
met, so `okproof gate` on its own only checks that a ledger agrees with its proof
file. It prints this warning when it runs that way:

    warning: ledger is not bound to a test run in this job.

Bind the gate to the job's own test run instead:

```bash
npx vitest run --reporter=junit --outputFile=junit.xml   # or any runner that writes JUnit or CTRF
npx okproof gate --results junit.xml --require-issues 142,143
```

`gate --results <file> [--format junit|ctrf]` rebuilds every ledger in memory
from that results file and the proof files, and ignores `.okproof/ledger-*.json`
completely. A forged ledger has no effect. The GitHub Action does this for you
whenever the `results` input is set, and prints a workflow warning when it is not.

Ledgers written by `okproof ingest` also record `results_sha256` (the hash of
the results file) and `proof_sha256` (the hash of the proof file text), so a
reviewer can tell which run and which criteria a ledger describes.

### Do not commit ledgers

Because the gate rebuilds them, committing ledgers is unnecessary and only
invites forgery. Keep proof files in git and ledgers out:

```gitignore
# okproof: proof files (.okproof/<issue>.md) are committed; ledgers are rebuilt in CI
.okproof/ledger-*
.okproof/verify-*.json
```

## One proof file per linked issue

A pull request that says "Closes #142" must carry `.okproof/142.md`. The Action
passes every linked issue to `okproof gate --require-issues`, so renaming 142.md
to another issue id, or replacing it with a file for an easier issue, fails the
gate with `#142 is linked by the pull request but there is no proof file`.
`okproof gate` also fails any proof file whose heading (`## #142 ...`) does not
match its filename, and `okproof sync --check` fails when the file's criteria,
title or heading differ from the issue.

Set the Action input `require-linked: false` only if your pull requests close
issues okproof does not track. With `sync: write` a missing proof file is
created from the issue instead.

## Verifier findings are attributed

`okproof verify` runs automatic detectors (console errors, failed requests, ...)
after every action. A finding refutes a criterion only if the agent's own action
caused it and, for network failures, the failing URL is on the app's origin:

- Findings from the initial page load, before the agent did anything, are
  recorded but do not refute (severity 2).
- Failed requests to another origin are third-party warnings (severity 1).

Pass `--strict-detectors` (option `strictDetectors`) for the old page-global
behaviour.

## Verifier authentication

To verify pages behind a login, give the verifier a session instead of a
password:

```bash
okproof verify --url http://localhost:3000 \
  --storage-state auth.json \
  --header 'X-Test-User: qa' \
  --login ./login.mjs
```

- `--storage-state <file>`: Playwright-compatible JSON,
  `{ cookies: [{ name, value, domain, path, expires, httpOnly, secure, sameSite }], origins: [{ origin, localStorage: [{ name, value }] }] }`.
  Cookies are set with `Network.setCookies`. localStorage entries are written
  for each origin before the page's own scripts run.
- `--header 'Name: value'` (repeatable): extra HTTP headers, set with
  `Network.setExtraHTTPHeaders`. Chrome sends them on every request the page
  makes, including to third-party origins, so use test credentials only.
- `--login <script.mjs>`: a module whose default export is
  `async (page) => void`, run before each criterion (and before each replay),
  where `page` is okproof's driver `Page` (`goto`, `click(ref)`, `type(ref, text)`,
  `evaluate`, `snapshot`, `command(method, params)` for raw DevTools Protocol).

Cookie and header values are never printed or written to `.okproof/`. Keep the
storage-state file out of git.

## Optional peer dependency

`@anthropic-ai/sdk` is an optional peer dependency, needed only by
`okproof verify` when it calls the Claude API. It is pinned to
`>=1.0.0 <2.0.0` (the current major is 1.x), so a future breaking major is not
picked up silently. Everything else in okproof has zero runtime dependencies.
