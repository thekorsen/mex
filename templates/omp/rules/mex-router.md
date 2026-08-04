---
description: Where to look in the .mex/ wiki. Read when starting any task, when you need this project's architecture, stack, conventions, decisions, or setup, or when checking whether an existing pattern runbook already covers the task.
---

<!-- mex-generated -->

# mex Routing

The living wiki is `.mex/`. Load the file that matches the task — do not guess project facts.

| Task type | Read |
|-----------|------|
| Understanding how the system works | `.mex/context/architecture.md` |
| Working with a specific technology | `.mex/context/stack.md` |
| Writing or reviewing code | `.mex/context/conventions.md` |
| Making a design decision | `.mex/context/decisions.md` |
| Setting up or running the project | `.mex/context/setup.md` |
| Any specific task | `.mex/patterns/INDEX.md` — check for a matching pattern first |

Load `.mex/context/architecture.md` first if it is not already in context this session.
Narrate what you load: "Loading architecture context..."

Then read `.mex/ROUTER.md` itself for `## Current Project State` (what works, what is not
built, known issues) and the full CONTEXT → BUILD → VERIFY → DEBUG → GROW behavioural
contract. Project state lives there and only there.

<!-- This rule is a static projection of `.mex/ROUTER.md`, emitted by `mex setup`.
     It contains pointers only — never copied project state — so its body cannot rot
     as the project changes. Anything volatile is read live from `.mex/`. -->
