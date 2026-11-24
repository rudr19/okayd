# Releasing okproof

Official versions are published only by `.github/workflows/release.yml`, when a
GitHub release is published. The workflow runs the tests, checks that the tag
equals `package.json`'s version, publishes to npm with a provenance
attestation, attests the tarball, and then moves the `v0` tag to the released
commit so `uses: rudr19/okproof@v0` follows it.

Nobody publishes from a laptop. Never run `npm publish` by hand: it would ship
without provenance.

## One time

1. **npm account.** Create one at npmjs.com and turn on 2FA (authorization and
   publishing). Create an npm organization if you want a home for later
   packages.
2. **Reserve the name.** `npm view okproof` returned 404 when this was written,
   so `okproof` is free; re-check with `npm view okproof` right before releasing.
   The first successful release claims the name. Also consider claiming the
   `@okproof` scope (create an npm org named `okproof`), since AUDIT.md flags the
   name as a collision risk.
3. **Create an npm token.** On npmjs.com: Access Tokens, Generate New Token,
   Granular Access Token. Permission: read and write, packages: `okproof` (for
   the very first publish the package does not exist yet, so choose "all
   packages" for that publish, then replace the token with one scoped to
   `okproof`). Set a short expiry and a calendar reminder to rotate it.
4. **Create the `npm` environment.** GitHub repo, Settings, Environments, New
   environment, name it exactly `npm`. Add yourself as a required reviewer, and
   restrict deployment to the `main` branch and `v*` tags.
5. **Add the secret.** In that environment, add a secret named `NPM_TOKEN`
   holding the token. It is an environment secret, not a repository secret, so
   only the release job can read it.
6. **Check tag rules.** The workflow force-moves `v0`. If you use tag
   protection or a tag ruleset, let GitHub Actions (or the repo admin role)
   update `v0`, or the last job will fail after a successful publish.
7. **Check Actions settings.** Settings, Actions, General: workflow permissions
   may stay on read-only. The jobs request what they need.

## Every release

1. Pick the version (Semantic Versioning; the `v0` tag line only covers
   `v0.x.y`).
2. On a branch, bump `version` in `package.json` (and run
   `npm install --package-lock-only --ignore-scripts` so `package-lock.json`
   matches).
3. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new
   `## [x.y.z] - YYYY-MM-DD` heading, and update the compare links if any.
4. Run `npm test` and `npm run smoke` locally. Both must pass.
5. Open a PR, wait for CI (which also runs the pack smoke test on Node 22),
   merge to `main`.
6. Create the GitHub release **from `main`**, with a tag that is exactly
   `v` plus the package version, for example:

   ```bash
   gh release create v0.1.0 --target main --title "v0.1.0" --notes "See CHANGELOG.md"
   ```

   (or use the GitHub web UI: Releases, Draft a new release, choose a new tag
   `v0.1.0` on `main`, paste the CHANGELOG entry, publish). Do not mark it as a pre-release: the workflow
   moves `v0` only for tags that match `v0.X.Y`.
7. Approve the `npm` environment deployment when GitHub asks. The workflow then:
   - fails fast if the tag differs from `package.json`'s version;
   - runs `npm ci --ignore-scripts` and `npm test`;
   - packs, attests the tarball (`actions/attest-build-provenance`), and runs
     `npm publish --provenance --access public`;
   - moves `v0` to the released commit.

## Verify the release

```bash
npm view okproof version dist.tarball          # 0.1.0
npm view okproof --json | grep -i provenance   # attestation present

# In a scratch project (not this repo):
mkdir /tmp/verify && cd /tmp/verify && npm init -y
npm i -D okproof
npm audit signatures                         # "verified registry signatures" and "verified attestations"
npx okproof nonsense; echo "exit $?"           # prints usage, exit 2: the CLI starts

# Tarball provenance, from a downloaded tarball:
npm pack okproof@0.1.0
gh attestation verify okproof-0.1.0.tgz --repo rudr19/okproof

# The moving tag:
git ls-remote --tags https://github.com/rudr19/okproof v0 v0.1.0   # same commit
```

## If something fails

- **Tag/version mismatch.** Nothing was published. Delete the release and tag,
  fix `package.json`, and create the release again.
- **Publish failed, nothing on npm.** Fix the cause (usually the token), then
  re-run the failed workflow run from the Actions tab. Re-running is safe: the
  same commit and tag are used.
- **Published, but `v0` did not move.** Re-run only the `move-major-tag` job.
- **A bad version is live.** Do not unpublish. Run
  `npm deprecate okproof@x.y.z "reason"`, then release a fixed patch.

## Node versions

`engines.node` is `>=20` for the core (proof files, ledger, gate, ingest, MCP
server, Playwright reporter). The Chrome driver and the verifier use Node's
built-in WebSocket and need Node 22 or later; `src/driver/cdp.ts` fails with
"The okproof browser driver needs Node 22 or later" otherwise. CI tests Node 20
and 22, and the pack smoke test runs on 22.
