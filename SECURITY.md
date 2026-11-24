# Security policy

## Supported versions

okproof is pre-1.0. Only the latest release gets security fixes.

## Reporting a vulnerability

Please report privately through GitHub:
**Security → Report a vulnerability** on
[rudr19/okproof](https://github.com/rudr19/okproof/security/advisories/new).

Don't open a public issue for a security problem.

You'll get an acknowledgement within 3 working days and a status update within
10. Once a fix ships, we'll credit you in the advisory unless you'd rather stay
anonymous.

## Scope

okproof reads proof files and test results, and writes ledgers. Reports we
especially want:

- A way to make a ledger say "proven" when a criterion did not pass
- Path traversal or code execution through proof files or options
- Leaking secrets or trace contents into ledgers or PR comments
