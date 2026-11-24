# Roadmap

Ordered by priority. Dates are intentions, not promises. Open an issue to argue
for a change.

## Now

- [x] Proof files, ledger and merge gate
- [x] Ledger posted as one PR comment and in the job summary
- [x] Playwright Test reporter and JUnit ingest for any runner
- [ ] Own Chrome driver over the DevTools Protocol, no dependencies

## Next

- [ ] **Okayd MCP server and agent skill.** Coding agents check `okayd status`
      before they claim "done" and see which criteria are unmet.
- [ ] **CTRF ingest.** Read the Common Test Report Format many runners emit.
- [ ] **Verifier agent.** For each criterion the diff touches, a separate agent
      tries to prove it false on the preview deployment.
- [ ] **Model-free replay.** Verifier runs record their actions and replay
      deterministically.

## Later

- [ ] **Harden.** Commit passing verifier runs as tests linked to criteria.
- [ ] **Signed ledgers.** Ledgers signed with GitHub OIDC so anyone can check
      who produced them and from which commit.
- [ ] **Hosted proof page** (optional) with history across pull requests.
- [ ] Firefox and WebKit support in the driver.

## Won't do

See the non-goals in [VISION.md](VISION.md).
