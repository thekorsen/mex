---
description: Retrieve compact task-relevant context from the mex code graph for a described task, then expand only the most relevant node ids.
---
<!-- mex-generated -->

Retrieve task-scoped context from the code graph.

**First, check that a task description was actually supplied.** If the argument below is empty, blank, or still looks like an un-substituted template token, do **not** run a scope query with it — an empty or literal-token query returns a meaningless neighborhood and wastes the budget. Instead, ask the user what task they want scoped, in one short question, and stop until they answer.

Task: `$ARGUMENTS`

With a real task description, run it as a single argument. `$ARGUMENTS` is substituted
**textually**, so quote it for the shell: use single quotes, and if the task itself
contains a single quote, pass the task via a heredoc or escape it rather than letting
it terminate the string.

```bash
mex graph scope '<the task description below>'
```

Then work the returned JSONL manifest per the retrieval playbook:

1. Read the manifest — `meta`, `fact`s, `summary`. It is a scored neighborhood under a hard token budget, deliberately compact: signatures, relationships, node ids, and selection reasons.
2. Pick **1-3** node ids that genuinely matter to the task. Expand only those: `mex graph get <id> --detail source`.
3. Treat source the graph returns as **ALREADY READ**. Do not re-open those files.
4. If the result reports `truncated`, do **not** repeat the broad query. Narrow the task description or follow the summary's `suggestedNextCommands`.
5. If you already know the symbol you need, a structural query is cheaper than scope: `mex graph query where-defined <symbol>`, `who-calls <symbol>`, `what-calls <symbol>`.
6. Before editing any symbol you found, run `mex impact <symbol|file>` to see affected callers and the wiki pages grounded to it.

Report the node ids you expanded and why you chose them, so the selection can be judged.
