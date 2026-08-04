---
name: omp-integration-identity-model
description: The four-layer identity model for mex — machine, scaffold, checkout, and contributor. Defines what each layer identifies, where it lives, whether it is committed, how it is produced, and whether telemetry may see it. Written before team features ship so identity never has to be retrofitted onto a committed UUID.
last_updated: 2026-08-04
---

# mex identity model

mex answers four different "who/where is this?" questions, and they are not the same
question. Conflating them is how a project ends up with one committed UUID doing five
jobs badly.

This document is the source of truth for which identifier answers which question. If
you are adding a feature that needs to tell two things apart — two machines, two
clones, two worktrees, two people — start here and use the layer that already exists.

## Why this document exists

`scaffold_id` lives in `.mex/config.json`, which is **committed**. That was the right
call for its actual job (cohort analysis: "one team on one project"), but it means the
value is shared by everyone who clones the repo. Once an identifier is committed, its
meaning is effectively frozen: changing it, or narrowing it, breaks every consumer that
already keyed on it — including historical telemetry cohorts.

So the model gets written down **before** team features ship, rather than being
reverse-engineered out of a committed UUID afterwards. This is the third scope bullet of
ticket #18. The concrete payoff: when a future feature needs "same working context?",
there is already a documented answer (the checkout layer) and nobody is tempted to
overload `scaffold_id` into a fifth role.

## The four layers

| Layer | Identifies | Lives in | Tracked? | Produced by | Stability | Telemetry may see it |
|-------|-----------|----------|----------|-------------|-----------|----------------------|
| **machine** | one computer | `~/.mex/telemetry-id` | untracked (outside the repo) | random UUIDv4, written mode `0600` | stable for the life of the file | **yes** — sent as `machine_id` |
| **scaffold** | one *project* | `scaffold_id` in `.mex/config.json` | **committed** | random UUIDv4, minted once at `mex setup` | never regenerated | **yes** — sent as `scaffold_id` |
| **checkout** | one *working tree* | nowhere — derived on demand | untracked by construction | `sha256(absolute git dir)` | stable per working tree; changes if the dir moves | **no** — not in the payload |
| **contributor** | one *person* | git's own `user.email` | git config, not mex state | `sha256(lowercased user.email)`, if ever needed | as stable as the user's git config | **no** — and never should |

### machine

- **File:** `~/.mex/telemetry-id`, one UUIDv4 plus a newline.
- **Produced by:** `getMachineId()` at `src/global-config.ts:67-75` — reads the file if
  present, otherwise mints `randomUUID()` and writes it with `{ mode: 0o600 }` so only
  the owner can read it. There is a deliberate read-only sibling, `readMachineId()`
  (`src/global-config.ts:50-59`), for paths like `telemetry inspect` that must not plant
  a tracking id on disk.
- **Relocatable:** the base directory comes from `mexHomeDir()`
  (`src/global-config.ts:30-33`), which honours `MEX_HOME` before falling back to
  `homedir()`. Tests use that seam to isolate themselves from the real home.
- **Not new.** This layer already existed; this work does not touch it.
- Answers: *"is this the same computer as last time?"* — and nothing else. It says
  nothing about which project or which person.

### scaffold

- **Field:** `scaffold_id` (plus `scaffold_name`) in `.mex/config.json`.
- **Produced by:** `ensureScaffoldIdentity()` at `src/config.ts:290-305`. It re-reads
  `config.json` from disk before deciding, so it is idempotent regardless of what the
  in-memory config believes: an existing id is *never* regenerated, and an empty
  `scaffold_name` is backfilled while keeping the id (`src/config.ts:291-299`). The
  persist is best-effort — a write failure is swallowed so telemetry bookkeeping can
  never change a command's exit code (`src/config.ts:301-303`).
- **Minted at:** `mex setup`, at `src/setup/index.ts:217`, guarded by `!dryRun` and
  deliberately independent of AI-tool selection so a setup that picks no tool still gets
  an id.
- **Deliberately shared.** `.mex/config.json` is committed, so **one `scaffold_id` is
  shared by every clone, every developer, and every worktree of a project**. That is the
  design, not a leak: "one scaffold = one project" (`src/types.ts:50-56`), which is what
  makes cohort analysis possible — it lets telemetry tell *"one team on one project"*
  apart from *"one person on many machines"* (`TELEMETRY.md:19`).
- **Its meaning is unchanged by this work.** This is a hard constraint from ticket #18:
  existing telemetry cohorts keyed on `scaffold_id` must keep meaning exactly what they
  meant before. Nothing here narrows it to a checkout.
- Answers: *"is this the same project?"*

### checkout — new

Per-working-tree identity. **Derived on demand and never persisted.**

```
checkout_id   = sha256(`git rev-parse --absolute-git-dir`).slice(0, 32)
checkout_name = basename(projectRoot)
```

- **Produced by:** `getCheckoutIdentity()` at `src/config.ts:340-349`, returning a
  `CheckoutIdentity` (`src/types.ts:68-72`). There is no file, no cache, and no write
  path — the derived value is memoized onto the in-memory config only
  (`src/config.ts:341,347`).
- **Why `--absolute-git-dir` is the right key** — every layout gives a value unique to
  the working tree (all executed, not assumed):

  | Layout | `git rev-parse --absolute-git-dir` |
  |--------|------------------------------------|
  | main checkout | `/abs/repo/.git` |
  | linked worktree | `/abs/main/.git/worktrees/<name>` |
  | submodule | `/abs/main/.git/modules/<sub>` |

  Confirmed live in the worktree this document was written from:
  `/Users/…/pi-tooling/mex/.git/worktrees/worktree`, whose toplevel is
  `/Users/…/fleet/wt/worktree` — a different path from the main checkout, and therefore
  a different `checkout_id`.
- **No repo? Still per-checkout.** `findConfig` allows a scaffold with no git repo above
  it, in which case `--absolute-git-dir` yields nothing and the hash falls back to
  `projectRoot` (`src/config.ts:342,344`). That is still unique per checkout; it is only
  weaker in that a *moved* non-git scaffold and a *renamed* one are indistinguishable
  from any other path change, which the model already accepts.
- **It fixes the frozen-name problem.** `scaffold_name` is the *committed* basename of
  whichever directory ran `mex setup` (`src/config.ts:299`), so a worktree checked out
  at `…/repo-feature-x` still reports `scaffold_name: "repo"`. `checkout_name` reads the
  live `projectRoot` basename, so that worktree reports
  `checkout_name: "repo-feature-x"` while `scaffold_name` correctly stays `"repo"`.
- **Hashed, not raw.** The absolute git dir is a filesystem path and therefore
  potentially identifying; only its digest is ever exposed, and only in-process. The
  32-hex-character prefix (128 bits) is ample for distinguishing checkouts and matches
  the existing graph node-id convention noted at `src/config.ts:336-337`.
- Answers: *"is this the same working context?"*

### contributor

**Deliberately not new mex state.** git already owns contributor identity via
`user.email`, so mex storing its own copy would add a second source of truth that can
silently disagree with the one git actually uses for commits.

- **If a team feature ever needs it**, the documented derivation is
  `sha256(lowercased user.email)` — computed on demand from `git config user.email`,
  never written to a file. Lowercasing first makes it stable across the case variations
  people put in their git config.
- **Not implemented.** No code in this repo produces a contributor id today, and this
  batch adds none. It is specified here so that the first feature to need it does not
  invent a fifth, incompatible scheme.
- **Why storing it would be worse:** the natural place would be `.mex/config.json`,
  which is committed — that puts an email address, or a hash of one, into the repository
  history where it cannot be retracted. That is PII in a committed file, and it directly
  contradicts the PII firewall the telemetry layer already enforces
  (`src/telemetry/index.ts:75-81`).
- Answers: *"is this the same person?"* — via git, on demand, when something finally
  needs it.

## Decisions

### Decision: checkout identity is derived, not stored

**Options considered**

1. Derive it from the working tree's absolute git dir, hold it only in memory.
2. Persist it in a new untracked `.mex/checkout.json`.
3. Mint a random UUID per checkout under `~/.mex/checkouts/`, keyed by path.

**Chosen:** (1) — derive `sha256(absolute git dir)`, never persist.

**Why**

A derived value is untracked *by construction*. There is no new file to accidentally
commit, so no `.gitignore` rule is required — and the `.gitignore` question is issue #12,
owned by a different lane, so depending on it here would couple two independent changes.
There is also no new env var, no migration, and no cleanup story. The value is stable
across runs because the git dir path is stable, and it is distinct per worktree *and*
per clone because git guarantees the git dir is unique per working tree.

Option (2) creates a file inside `.mex/` that looks exactly like the committed config
next to it, which invites both accidental commits and hand-editing — and a hand-edited
identity is worse than no identity, because it is silently wrong. Option (3) needs a
keyed registry mapping paths to UUIDs, which then needs garbage collection when
checkouts are deleted; that is real machinery, and a stale registry entry is another way
to be silently wrong.

**What this rules out**

Surviving a move or rename of the checkout directory: a moved checkout gets a new
`checkout_id`. That is accepted — a checkout at a new path *is* a different working
context, and nothing in the model promises otherwise. Also ruled out: any feature that
needs a checkout identity to outlive the checkout itself (e.g. server-side history keyed
on checkout).

**Revisit if**

A feature genuinely needs checkout identity to survive a directory move, or needs to
correlate a checkout across machines. Either would require stored state, and that
trade — a new untracked file plus its ignore rule and cleanup path — should be made
explicitly, not smuggled in.

### Decision: `origin` / `upstream` are removed, not implemented

**Options considered**

1. Implement a writer that populates them (realistically: from the git remote URL).
2. Remove both fields.

**Chosen:** (2) — remove. Ticket #18 explicitly permits either "implemented with a
defined writer, or removed."

**Why**

The only plausible writer is the git remote URL, and remote URLs can embed credentials
(`https://user:token@host/…`). `.mex/config.json` is **committed**, so that writer would
write a credential-bearing string into repository history. It is unsafe by construction,
not by accident, and it contradicts the PII firewall documented at
`src/telemetry/index.ts:75-81`. Meanwhile the thing these fields would notionally
provide — cross-checkout identity — is already `scaffold_id`, so there is no unmet need
to satisfy. Removing fields that no writer populated and no reader consumed is inert in
practice.

**What this rules out**

Any remote-derived identity in `.mex/config.json`. If a feature later needs "which
forge/remote is this?", it must read git directly at runtime and must not persist the
URL to a committed file.

**Revisit if**

A feature needs remote provenance. The answer is a runtime lookup with credential
stripping, not a committed field.

## The `origin` / `upstream` removal

This is ticket #18's second acceptance criterion, so the evidence is recorded in full.

**What they were.** `ScaffoldIdentity` carried `origin: string | null` and
`upstream: string | null`, introduced by commit `e607a55`
*"feat: scaffold identity (E1) (#73)"*.

**They were plumbing and nothing else.** Line numbers below are as of *before* this
removal — they no longer resolve, which is the point. Across `src/`, `packages/`,
`test/`, and `templates/`, the only occurrences were:

- declared — `src/types.ts:60-63`
- loaded from disk — `src/config.ts:216-217`
- persisted back — `src/config.ts:262-263`
- null-defaulted when minting — `src/config.ts:286-287`
- round-tripped in tests

**No writer ever set them non-null, and no reader ever consumed them.** There is no code
path that produces a non-null value and no code path that branches on one.

**Nothing external depends on them.** `COMPATIBILITY.md` never mentions either field
(zero grep hits), so removal does not touch a documented compatibility surface — even
though the surrounding `getScaffoldIdentity` accessor *is* documented as public
(`src/config.ts:307-317`).

**Telemetry already treated them as radioactive.** `src/telemetry/index.ts:75-81`
documents that `scaffold_name`, `origin`, and `upstream` must never reach PostHog, and
`test/telemetry.test.ts:160-166` asserts that the built payload has none of those three
properties. Removing the fields removes two of the three hazards outright.

**Stale keys on disk survive untouched, on purpose.** A `config.json` written by an
earlier version may still contain `"origin": null` and `"upstream": null`. Those keys are
harmless and are left alone:

- `MexPersistedConfig` has an index signature, `[key: string]: unknown`
  (`src/config.ts:118`), so unknown keys parse without complaint — and the reason is
  recorded right above it (`src/config.ts:116-117`).
- `mergeIntoConfig` shallow-merges a patch into the existing object via `Object.assign`
  and writes the result (`src/config.ts:254-268`), explicitly so that independent writers
  never clobber each other's keys. Keys not named in a patch are preserved verbatim.

**No migration code strips them, deliberately.** A migration would be write traffic
against every existing scaffold's committed config, producing a diff in every repo, to
delete two keys that are already ignored. The cost is real and the benefit is zero. The
keys simply stop being read; they age out naturally the next time anything rewrites the
file.

## Telemetry boundary

`buildPayload` (`src/telemetry/index.ts:82-97`) is the single place the payload shape is
defined, and it is a **fixed 6-key payload**: `machine_id`, `command`, `mex_version`,
`os`, `node_version`, and `scaffold_id` (the last only when a scaffold is present). The
whitelist is asserted by `test/telemetry.test.ts:146-158`, and the field-by-field
user-facing contract is `TELEMETRY.md:16-23`.

**`checkout_id` is not added to it by this work.** The checkout layer exists to let mex
itself tell working trees apart in-process; it is not a telemetry dimension. Adding any
new identifier to the payload would be a separate, deliberate decision with its own
privacy review and its own update to `TELEMETRY.md` — not a side effect of introducing
an internal identity layer.

Existing cohorts keyed on `scaffold_id` are unaffected: its value, its lifecycle, and its
meaning are all unchanged.

## What a future team feature should use

| The question you are asking | Layer | How to get it |
|-----------------------------|-------|---------------|
| "Is this the same **project**?" | scaffold | `getScaffoldIdentity(config).scaffold_id` (`src/config.ts:312-317`) |
| "Is this the same **working context**?" (clone, worktree, submodule) | checkout | `getCheckoutIdentity(config).checkout_id` (`src/config.ts:340-349`) |
| "Is this the same **machine**?" | machine | `getMachineId()` (`src/global-config.ts:67-75`) — telemetry-gated; use `readMachineId()` on read-only paths |
| "Is this the same **person**?" | contributor | not implemented; derive `sha256(lowercased user.email)` from git on demand |

Two rules for anyone extending this:

1. **Do not overload a layer.** If your question is not one of the four above, it needs
   its own answer, documented here — not a new meaning bolted onto `scaffold_id`.
2. **Do not persist identity into a committed file.** `.mex/config.json` is committed;
   anything written there is published to everyone who clones the repo, permanently.

## Evidence notes

Every `path:line` above was read directly. Two claims are inferential:

- `[INFERENCE]` "the only plausible writer for `origin`/`upstream` was the git remote
  URL." No writer was ever committed, so the intended source cannot be read out of the
  code; the field names and the `e607a55` commit message are the only signal. Settled by
  the PR discussion on #73 or by the author stating the intent — and moot either way,
  since the fields are removed.
- `[INFERENCE]` "no `.gitignore` rule would be needed for a derived checkout id" is
  trivially true for the chosen option, but the claim that a *stored* `.mex/checkout.json`
  would require coordinating with issue #12 assumes that issue still owns the ignore
  rules for `.mex/`. Settled by reading issue #12's final scope.
