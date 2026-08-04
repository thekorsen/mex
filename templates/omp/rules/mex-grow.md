---
description: The GROW step that keeps the .mex/ wiki from rotting. Read after completing meaningful work — a feature, a fix, a dependency or workflow change — before reporting the task done.
---

<!-- mex-generated -->

# GROW

After meaningful work, run this binary checklist. The scaffold grows from real work, not just setup.

- **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
- **Record:** If project state changed, update `## Current Project State` in `.mex/ROUTER.md`. If documented facts changed, update the relevant `.mex/context/` file surgically — edit the affected lines, do not rewrite the file.
- **Orient:** If this task can recur and no pattern covers it, create one in `.mex/patterns/` following `.mex/patterns/README.md`, then add its row to `.mex/patterns/INDEX.md`. If a pattern exists but you learned a gotcha, add the gotcha to it.
- **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` — otherwise `mex log "<note>"`.

Then run `mex check` and fix what it reports. Do not edit `.mex/` prose just to silence it.
