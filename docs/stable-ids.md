# Stable criterion ids

By default a criterion's id is its position: the third `- [ ]` line of
`.okproof/142.md` is `142.3`. Insert or remove a line above it and every later id
shifts, so tests tagged with the old id silently claim the wrong criterion.

Give a criterion a stable id with a `{#id}` prefix:

```md
## #142 Auth
- [ ] {#login} A user can sign in
- [ ] A user can reset a password
- [ ] {#sign-out} A user can sign out
```

The ids are `142.login`, `142.2` and `142.sign-out`. Tag tests with
`[okproof:142.login]`. Lines without `{#...}` keep their positional id, so
existing proof files work unchanged.

Rules: the id uses only `a-z`, `0-9` and `-`, contains at least one letter, and
is unique within the file. `okproof check`, `sync`, `gate` and `lint` reject
anything else with a message.

`okproof sync` keeps the `{#id}` when it rewrites a proof file and matches
criteria by their text, so ids do not move when the issue's checkboxes are
reordered, added or removed. A `{#id}` written in the issue's checkbox text is
adopted by sync. Ids are matched as plain strings everywhere (ledger, gate,
lint, MCP tools).
