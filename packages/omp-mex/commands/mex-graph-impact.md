---
description: Review the blast radius of a change before making it — resolve the target in the code graph, list its transitive callers, and name the wiki pages that will owe an update.
---

<!-- Deliberately carries no mex-generated provenance marker. That marker means
     "emitted into a consuming repo's `.omp/` by `mex setup`", and the omp-artifacts
     drift checker treats its absence as "hand-written by the user, none of mex's
     business" (`src/drift/checkers/omp-artifacts.ts:9-14`). This file is neither: it
     ships inside the `mex-omp` package and is discovered as a sibling capability root
     of the loaded extension (`omp://skills/authoring-extensions.md:97`), never
     projected into `.omp/`. Claiming generated provenance would simply be false.
     The marker string is not written out literally even inside this comment. Today
     that is only hygiene — the checker globs `.omp/rules/mex-pattern-*.md` alone
     (`:122-125`) and never reads this path — but its test is a plain
     `content.includes(...)` (`:139`) with no position or frontmatter constraint, so a
     literal occurrence anywhere in a scanned file counts as the claim. Keeping the
     literal out of package-shipped artifacts costs nothing and cannot rot. -->

Assess what a change to a symbol or file would break, before writing the change.

**First, check that a target was actually supplied.** If the target below is empty,
blank, or still looks like an un-substituted template token, do **not** run an impact
query with it — an empty target resolves to nothing and burns the budget on a
meaningless answer. Ask the user which symbol or file they intend to change, in one
short question, and stop until they answer.

Target: `$ARGUMENTS`

Now call the **`mex_impact` tool** with that target:

```
mex_impact { target: "<the target above>", detail: "standard" }
```

**Pass the target as a tool argument. Do not build a shell command out of it.**
`$ARGUMENTS` is substituted **textually** into this file, so a target containing a
quote, a backtick, or a `$` would terminate or inject into any `mex impact '...'`
shell line assembled around it. A tool argument is a JSON string, so the same
characters are inert data — the injection surface simply does not exist. `mex_impact`
runs the identical in-process query the CLI runs, so nothing is lost by preferring it.

Then work the returned JSONL:

1. Read the `summary` record. `truncated: true` means callers were **dropped, not
   clipped** — the blast radius is at least what you see and possibly larger. Do not
   report a caller count from a truncated result.
2. If the result is `{"type":"error","code":"TARGET_AMBIGUOUS", ...}`, pick the
   intended id from `candidates` and re-run `mex_impact` with that node id rather
   than guessing which one the user meant.
3. If it is `{"type":"error","code":"GRAPH_UNAVAILABLE"}`, the local code graph has
   not been built. Run `mex graph`, then retry — do not fall back to grepping for
   callers by hand, which is exactly the unreliable answer the graph exists to replace.
4. Widen only if the radius looks suspiciously small: raise `depth` (default `2`) one
   step at a time, or raise `maxNodes`. Re-running the same query unchanged returns
   the identical dropped set.
5. For any caller you cannot judge from its signature alone, expand just that one:
   `mex_graph_get { ids: ["<id>"], maxSourceLines: 60 }`. Treat source the graph
   returns as **already read** — do not re-open those files.

Impact also surfaces the `.mex/` wiki pages grounded to the target. Those pages are
the documentation debt the change creates: if you go on to make the edit, they are
what you owe an update to, and `mex check` will report them if you do not.

Report: the resolved target, the affected callers grouped by file, the grounded wiki
pages that will need updating, whether the result was truncated, and your judgement of
whether the change is safe to make as scoped or should be split.
