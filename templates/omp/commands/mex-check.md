---
description: Run mex check and act on the drift report — decide per issue whether reality changed or the wiki claim was wrong.
---
<!-- mex-generated -->

Run the wiki health check and act on what it reports. This command takes no arguments.

```bash
mex check
```

`mex check` validates paths, commands, dependencies, links, indexes, staleness, tool configuration, and grounded code symbols against the repository. It spends no AI tokens. A **nonzero exit means at least one error-severity issue** was found; warning-only reports exit clean.

Then read the report and work it issue by issue. For each one, decide which side is wrong:

- **Reality changed** — the code, command, or dependency moved and the `.mex/` page still describes the old world. Update the page. Surgical edits only: change the stale sentence or field, preserve the frontmatter structure, and bump `last_updated`.
- **The claim was wrong** — the page asserted something that was never true, or grounds to a symbol that does not embody the claim. Fix or remove the claim, and repoint or drop the `grounds_to` entry.

For grounding issues, resolve them against the graph rather than by inspection: `mex graph query where-defined <symbol>`, `mex impact <symbol|file>`.

**Editing `.mex/` prose merely to silence the checker is forbidden.** Deleting an inconvenient claim or loosening it into vagueness makes the check pass while destroying the only signal this tool produces. If an issue is a genuine false positive, say so explicitly in your report and leave the claim intact.

If the report has many issues, run `/mex-sync` — it hands you only the drifted files with targeted context instead of the whole project.

Finish by reporting: how many issues at each severity, which files you changed and why, and any issue you deliberately left open.
