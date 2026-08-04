# omp integration — agent work area

This folder is the working area for adapting **mex** to the **oh-my-pi (`omp`)** agent harness.

## Read first

**[`AGENT-ONBOARDING.md`](AGENT-ONBOARDING.md)** — mandatory before touching any `omp-integration` issue. It carries:

- what mex is and where its public API boundary sits
- omp's nine extension surfaces, their discovery precedence, and Claude Code compatibility
- the **evidence ledger**: what was verified by execution, what by source reading, and what was never verified
- environment setup, including how to reproduce the worktree failures and how to probe omp's context injection
- the issue map with real dependencies and a suggested order
- the definition of done, and the anti-patterns that get a PR rejected

## Layout

```
docs/omp-integration/
├── README.md              # this file
├── AGENT-ONBOARDING.md    # the context handoff — read before working any ticket
└── notes/
    ├── TEMPLATE.md        # copy this per ticket
    └── <issue>-<slug>.md  # one working note per issue
```

## Working a ticket

1. Read `AGENT-ONBOARDING.md` end to end.
2. Read the issue. Every issue is self-contained — problem, evidence, scope, acceptance.
3. `cp notes/TEMPLATE.md notes/<issue-number>-<slug>.md` and fill the header before you start.
4. Branch: `omp/<issue-number>-<slug>`.
5. Keep the note current as you go — especially the **dead ends**. What you ruled out is usually the expensive half, and it is the part that is lost if you do not write it down.
6. Verify by running the thing. Paste real output into the PR.
7. If you resolve an `[INFERENCE]` from the ledger, promote it into the verified section of `AGENT-ONBOARDING.md` in the same PR.

## Milestones

| Milestone | Meaning |
|---|---|
| **Tier 0 — works today, zero code** | Document and test the integration that already functions (MCP server + `@`-import anchor). No mex source changes. |
| **Tier 1 — native omp surfaces** | Make omp a first-class target: `.omp` anchor, rulebook rule, graph over MCP, omp as a sync-capable CLI, skills and commands. |
| **Tier 2 — omp extension module** | One extension owning routed per-turn injection, graph tools, commands, and supervised watching. Depends on Tier 1. |
| **Correctness — harness-independent bugs** | Defects that are wrong under any harness: subdirectory graph resolution, worktree hooks, gitignore hygiene, MCP process-global state. |
| **Multi-developer reconciliation** | Make mex safe in a shared production repo: CI gating, shareable grounding baselines, upstream-aware staleness, conflict-tolerant knowledge. |

## Labels

`blocker` · `bug` · `design-decision` · `good-first-slice` · `graph` · `multi-dev` · `worktree` · `ci` · `docs` · `omp-integration`

`good-first-slice` means bounded and safe for a fresh session. `design-decision` means **write the decision down before implementing** — those tickets are not closed by an unstated guess.

## Relationship to upstream

This is a fork of [`mex-memory/mex`](https://github.com/mex-memory/mex). `upstream` is read-only; push only to `origin`. Several tickets here — the worktree hook, the subdirectory graph resolution, the missing `.gitignore` rule, the dangling `SETUP.md` script references — are harness-independent bugs that would be worth contributing back, so keep those branches clean and rebasable.
