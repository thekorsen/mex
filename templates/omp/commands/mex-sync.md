---
description: Run mex sync to repair wiki drift with targeted per-file context, making surgical edits and adjudicating AMBIGUOUS grounding.
---
<!-- mex-generated -->

Repair the drift that `mex check` found. This command takes no arguments.

```bash
mex sync
```

`mex sync` detects drift, then hands you **only the drifted files** with a targeted brief for each — you are not re-reading or re-deriving the whole project. Work one file at a time, in the order sync presents them.

Rules for every repair:

- **Surgical edits, not rewrites.** Read the existing content, identify precisely what drifted, and change only that. A whole-file rewrite destroys accumulated wisdom that nothing flagged.
- **Preserve frontmatter.** Never delete or regenerate a frontmatter block. Edit individual fields; add or remove individual `edges` / `triggers` / `grounds_to` entries rather than replacing arrays.
- **Never delete a decision.** In `.mex/context/decisions.md`, mark a superseded entry as "Superseded by [new decision title]" and add the new decision above it with today's date.
- **Adjudicate AMBIGUOUS grounding.** Do not guess. Use `mex graph scope`, `mex graph query where-defined <symbol>`, and `mex impact <symbol|file>` to decide whether the surfaced candidate is the same behavior. If it is, update `grounds_to` and any matching inline `mex://` anchor to that id, and refresh the fingerprint from the same graph fact. If it is not, choose the correct node or remove the stale grounding and anchor.
- **Do not paper over drift.** Rewording a claim into vagueness so the checker stops complaining is not a repair. Fix the fact or fix the code.
- **Bump `last_updated`** in the frontmatter of every file you change, and update the "Current Project State" section of `.mex/ROUTER.md` if project state moved.

When sync finishes, re-run `mex check` to confirm the repairs landed, then report: which files were updated and what changed, any decisions superseded, any grounding you repointed, and anything you could not resolve with confidence.
