# Governance

## Roles

- **Maintainer and project lead:** Rudra Kumar Pandey ([@rudr19](https://github.com/rudr19)).
  Owns the roadmap, final decisions, releases, the trademark and the
  security process.
- **Contributors:** anyone who opens an issue, reviews a change or sends a
  pull request under the [contribution rules](CONTRIBUTING.md).
- **Committers** may be added later from regular contributors with a track
  record of good reviews. They're listed in [CODEOWNERS](.github/CODEOWNERS).

## How decisions are made

1. Small changes: a pull request with passing checks and maintainer approval.
2. Larger changes (new commands, file formats, anything touching the
   [principles](VISION.md#principles)): open an issue with a short proposal
   first. Discussion stays open for at least 5 days.
3. The maintainer decides when discussion doesn't reach agreement, and writes
   down why in the issue.

## Compatibility

- Proof file format and ledger JSON are public interfaces. Breaking them needs
  a major version and a migration note.
- Until 1.0, minor versions may break APIs; the changelog always says how.

## Releases

Releases are cut from `main` by the release workflow only. Every published
npm version carries a provenance attestation linking it to the exact commit and
workflow run. Builds from anywhere else are not official okproof releases.

## Ownership and licensing

- Code: [Apache-2.0](LICENSE). Contributions come in under the
  [CLA](CLA.md) and are signed off under the DCO.
- Name and logo: see [TRADEMARK.md](TRADEMARK.md).
- Copyright: Rudra Kumar Pandey and contributors.

## Changes to this document

Through a pull request, approved by the maintainer.
