---
name: okayd
description: Use before telling the user a coding task is done, whenever the repo has an .okayd/ folder of proof files. Checks the task's acceptance criteria are proven by passing tests.
---

# Okayd: the definition of done

This repo proves work against acceptance criteria in `.okayd/<issue>.md`. A task
is not finished until Okayd says so.

1. Call `okayd_criteria` to see the criteria and the tag for each, e.g. `[okayd:142.1]`.
2. Write or update tests so each criterion has a test whose title contains its tag,
   e.g. `test('member can upgrade [okayd:142.1]', ...)`.
3. Run the tests with the Okayd reporter, or with a JUnit reporter and then call
   `okayd_ingest_junit`.
4. **Before saying the task is done, call `okayd_status`.** If it says "Not done",
   work through its "Next steps". Do not report completion while any criterion is
   failed or untested.

Rules:

- Use `okayd_add_criterion` to record a new requirement you discover. There is no
  tool to remove or edit criteria, and you must not hand-edit or delete lines in a
  proof file to make a task pass.
- Never weaken a proof file (rewording a criterion to be easier, deleting it,
  ticking it off by hand) without telling the user exactly what you changed and why.
- If a criterion looks wrong or impossible, stop and ask the user.
- A stale-ledger warning means the tests need re-running before you trust the result.
