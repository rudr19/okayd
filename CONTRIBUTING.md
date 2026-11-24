# Contributing to okproof

Thanks for helping. A few rules keep the project healthy and its ownership clear.

## Before you start

- For anything bigger than a typo, open an issue first so we can agree on the approach.
- Security problems: don't open a public issue. See [SECURITY.md](SECURITY.md).

## Contributor License Agreement

Every contributor signs the [CLA](CLA.md) once. Comment on your first pull request:

> I have read the okproof CLA and I agree to it.

Pull requests without a signed CLA can't be merged.

## Development

```bash
npm ci
npm test               # builds, then runs node:test
node dist/src/cli.js check
```

Requirements: Node 20 or later.

## Pull requests

- One change per pull request, with a test for any behaviour change.
- `main` is protected: CI (Node 20 and 22) and CodeQL must pass, and the
  maintainer must approve.
- Commits must be signed off (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).
- Keep the rule that untested or flaky results never count as proven. That
  rule is the product.

## Trademark

The code is Apache-2.0. The name "okproof" and its logo are not covered by that
license. See [NOTICE](NOTICE).
