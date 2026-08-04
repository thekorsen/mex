# Tool Configuration Files

These files make the scaffold work with specific AI coding tools.
Most embed the same content — a pointer to `.mex/ROUTER.md`. OpenCode uses a JSON config that references `.mex/AGENTS.md` instead.

## Which file does your tool use?

| Tool | File to use |
|------|-------------|
| Claude Code | `CLAUDE.md` → copy or symlink to project root |
| Cursor | `.cursorrules` → copy or symlink to project root |
| Windsurf | `.windsurfrules` → copy or symlink to project root |
| GitHub Copilot | `copilot-instructions.md` → copy to `.github/` in project root |
| OpenCode | `opencode.json` → copy to `.opencode/` in project root |
| Codex (OpenAI) | Copy `CLAUDE.md` as `AGENTS.md` to project root |
| oh-my-pi (omp) | `mex setup` writes `.omp/` — anchor bridge, rulebook, skill, commands (see below) |
| Any other tool | Point agent to `.mex/AGENTS.md` |

## Setup

Copy the relevant file to the correct location in your project root:

```bash
# Claude Code
cp .tool-configs/CLAUDE.md ./CLAUDE.md

# Cursor
cp .tool-configs/.cursorrules ./.cursorrules

# Windsurf
cp .tool-configs/.windsurfrules ./.windsurfrules

# Copilot
mkdir -p .github && cp .tool-configs/copilot-instructions.md ./.github/copilot-instructions.md

# OpenCode
mkdir -p .opencode && cp .tool-configs/opencode.json ./.opencode/opencode.json

# Codex (OpenAI)
cp .tool-configs/CLAUDE.md ./AGENTS.md

# oh-my-pi (omp) — installed by `mex setup`, choice 7
# omp reads .claude/CLAUDE.md, NOT root CLAUDE.md, so it gets its own native target:
#   .omp/AGENTS.md              one-line `@../.mex/AGENTS.md` import (references, never copies)
#   .omp/RULES.md               sticky non-negotiables
#   .omp/rules/mex-*.md         routing table, graph discipline, GROW, one rule per pattern
#   .omp/skills/mex-wiki/       retrieval playbook, fetched on demand
#   .omp/commands/mex-*.md      /mex-check, /mex-sync, /mex-graph-scope
# Every name is `mex-` prefixed: omp dedups first-wins by bare name, so an
# unprefixed artifact would shadow or be shadowed by the user's own.
# See docs/omp-integration/omp-surface-mapping.md
```

## If your tool is not listed

Add "Read .mex/ROUTER.md before starting any task" to your tool's system prompt
or paste it at the start of each session. The scaffold works identically.

## Content

Most files embed the Circle 1 anchor from `.mex/AGENTS.md`. OpenCode's `opencode.json` references it by path instead.
`.mex/AGENTS.md` is the source of truth. If you update it, update your root tool config too.
