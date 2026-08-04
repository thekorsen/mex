# Issue #18 — Two checkouts of the same repo share one scaffold_id, so telemetry and team features cannot tell them apart

- **Issue:** https://github.com/thekorsen/mex/issues/18
- **Milestone:** Correctness — harness-independent bugs
- **Branch:** `omp/worktree`
- **Status:** done
- **Started:** 2026-08-04
- **Last updated:** 2026-08-04

> Read [`../AGENT-ONBOARDING.md`](../AGENT-ONBOARDING.md) before working this ticket.

---

## Restated goal

mex has exactly one project-level identifier, `scaffold_id`, and it lives in a **committed** file — so
every clone, every developer and every worktree of a repo reports the same one, and there is no way to
tell working contexts apart. Write down the whole identity model (machine, scaffold, checkout,
contributor), add the missing per-checkout layer without breaking what `scaffold_id` already means to
existing telemetry cohorts, and settle the fate of the two reserved-but-never-written `origin` /
`upstream` fields.

## Acceptance criteria

Copied verbatim from `FLEET-TICKETS/18.md:31-33`.

- [x] A written identity model in `docs/omp-integration/` covering: machine, scaffold, checkout, and contributor.
- [x] `origin`/`upstream` are implemented with a defined writer, or removed.
- [x] Whatever ships does not break existing telemetry cohorts (an existing `scaffold_id` keeps its meaning).

---

## Findings

What you learned about the code. Every structural claim carries `path:line`.

| Finding | Evidence | Verified? |
|---|---|---|
| `.mex/config.json` is **committed** and carries a single `scaffold_id`. `ensureScaffoldIdentity` short-circuits when an id already exists, so it is minted exactly once per project and then inherited verbatim — by every clone, every developer, and every worktree, since a fresh worktree checks out the same committed file. Same `scaffold_id`, different `machine_id`. | `src/config.ts:276-293` (short-circuit); `~/.mex/telemetry-id` machine id at `src/global-config.ts:67-75` | read + executed (lane orchestrator) |
| `scaffold_name` is `basename(projectRoot)` **frozen at first mint** — never recomputed. A worktree at `…/repo-feature-x` therefore reports `scaffold_name: "repo"`, naming a directory it is not in. | `src/config.ts:285` | read |
| `git rev-parse --absolute-git-dir` is **unique per working tree**: main checkout → `/abs/repo/.git`, linked worktree → `/abs/main/.git/worktrees/<n>`, submodule → `/abs/main/.git/modules/sub`. This is the key the new checkout identity hashes — git already maintains a per-working-tree unique string, so mex does not need to invent or store one. | git 2.50.1, all three layouts run | executed (lane orchestrator) |
| `config.scaffoldRoot` is `<projectRoot>/.mex` with no walk-up (`findScaffoldRoot` is a single `existsSync`), and `existsSync(resolve(current, ".git"))` is true for a `.git` **file** — which is precisely what makes a worktree its own project root, and therefore a legitimately distinct checkout. Untouched by this work. | `src/config.ts:307-310`; `src/config.ts:95`; ledger §4.2 (`docs/omp-integration/AGENT-ONBOARDING.md:138`) | read |
| **This resolves ledger §4.3's open item** "`origin` / `upstream` in `ScaffoldIdentity` … Purpose unknown (issue #18)" (`docs/omp-integration/AGENT-ONBOARDING.md:161`). The fields arrived in commit `e607a55` "feat: scaffold identity (E1) (#73)". They are loaded (`src/config.ts:216-217`), persisted (`src/config.ts:262-263`) and null-defaulted at mint (`src/config.ts:286-287`) — and that is the entire lifecycle. A grep across `src/ packages/ test/ templates/` finds **no writer that sets either field non-null** and **no reader that consumes either field**; the only other hits are the config round-trip assertions in the test suite. `COMPATIBILITY.md` never mentions them (zero hits), so no compatibility promise depends on them. `src/telemetry/index.ts:79-80` documents that they must never reach PostHog and `test/telemetry.test.ts:160-166` asserts it. Conclusion: **reserved-but-never-wired**, with an explicit firewall around them. | commit `e607a55`; `src/types.ts:60-63`; `src/config.ts:216-217`, `:262-263`, `:286-287`; `src/telemetry/index.ts:79-80`; `test/telemetry.test.ts:160-166`; zero grep hits in `COMPATIBILITY.md` | read + executed (grep, lane orchestrator) |
| Promotion: that item moves from **§4.3 (explicitly NOT verified)** to **§4.2 (verified by source reading)** — the purpose is no longer unknown, it is *absent*, and the resolution is removal (Decision B). The **parent lane owns editing `AGENT-ONBOARDING.md`**, so this note records the promotion and does not perform it; §4.3 line `:161` should be struck and restated under §4.2 with the `e607a55` provenance and the removal decision. | `docs/omp-integration/AGENT-ONBOARDING.md:161` (§4.3), `:136-139` (§4.2) | read |
| Removing the fields is inert on existing installs: `mergeIntoConfig` shallow-merges and preserves keys it does not know about, so stale `"origin": null` / `"upstream": null` already on disk simply survive as unread data. No migration code is warranted or wanted. | `src/config.ts:238-252` | read |
| `buildPayload` is a fixed six-key payload. No new identifier is transmitted by this ticket. | `src/telemetry/index.ts:82-97` | read |
| The ticket's own framing agrees that a per-checkout id must be **untracked** — "the whole point is that it differs per checkout" — and points at the `.gitignore` work as the sibling file's home. A *derived* value satisfies the untracked requirement without needing that file at all. | `FLEET-TICKETS/18.md:25` | read |

## Commands run

Actual commands and actual output. This is the proof, not a summary of the proof.

Recorded by the lane orchestrator; the scratch repo lived under `/tmp` and has been removed. **Do not
re-run these as part of this ticket.**

```
$ git --version
git version 2.50.1

# one git dir per working tree — main, linked worktree, submodule
$ cd /tmp/mex-idprobe            && git rev-parse --absolute-git-dir
/private/tmp/mex-idprobe/.git
$ cd /tmp/mex-idprobe-wt         && git rev-parse --absolute-git-dir
/private/tmp/mex-idprobe/.git/worktrees/mex-idprobe-wt
$ cd /tmp/mex-idprobe/sub        && git rev-parse --absolute-git-dir
/private/tmp/mex-idprobe/.git/modules/sub
```

Shape of the derived checkout identity, for reference (`sha256(absolute git dir)`, first 32 hex chars):

```
$ printf '%s' /private/tmp/mex-idprobe/.git | shasum -a 256 | cut -c1-32
$ printf '%s' /private/tmp/mex-idprobe/.git/worktrees/mex-idprobe-wt | shasum -a 256 | cut -c1-32
# distinct values; stable across repeated runs
```

Provenance and reach of `origin` / `upstream`:

```
$ git log --oneline -1 e607a55
e607a55 feat: scaffold identity (E1) (#73)

$ grep -rn '\borigin\b\|\bupstream\b' src/ packages/ test/ templates/
# only: src/config.ts:216-217 (load), :262-263 (persist), :286-287 (null default),
#       src/types.ts:60-63 (declaration), src/telemetry/index.ts:79-80 (exclusion comment),
#       test/telemetry.test.ts:160-166 + config round-trip assertions.
# no assignment of a non-null value; no read of either field.

$ grep -c 'origin\|upstream' COMPATIBILITY.md
0
```

```
$ npm run build
ESM dist/index.js     142.55 KB
ESM dist/cli.js     317.35 KB
DTS dist/index.d.ts 21.66 KB
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/

$ npx vitest run
Test Files  38 passed (38)
Tests  380 passed (380)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)
# exit 0 — baseline HELD, no regression

$ git log --oneline -2
14c6c70 fix(watch): resolve the post-commit hook via git, not a structural .git path
efe4f33 feat(config): add a derived per-checkout identity; drop dead origin/upstream.
```

---

## Decisions

For `design-decision` tickets this section is the deliverable and must be written **before** implementation.

### Decision B: a four-layer identity model; the checkout layer is DERIVED, never stored; `origin`/`upstream` are removed

- **Options considered:**
  1. **Leave identity as-is** (machine + scaffold only) and accept that working contexts are
     indistinguishable.
  2. **Add a per-checkout id stored in a new untracked file**, `.mex/checkout.json`, minted randomly
     on first use.
  3. **Add a per-checkout id stored outside the repo**, a random UUID under
     `~/.mex/checkouts/<hash-of-path>`, with a registry keyed by absolute path.
  4. **Derive the per-checkout id** from something git already guarantees is unique per working tree,
     and never persist it.
  And for the reserved fields: (a) implement `origin`/`upstream` with a real writer (the git remote
  URL), or (b) remove them.
- **Chosen:** **Option 4**, expressed as four explicit layers, plus **(b) remove** the reserved fields.

  | Layer | Value | Storage |
  |---|---|---|
  | **machine** | UUIDv4 in `~/.mex/telemetry-id` | outside the repo, untracked, **already exists** (`src/global-config.ts:67-75`) — unchanged |
  | **scaffold** | `scaffold_id` in the **committed** `.mex/config.json` | one per **project**, deliberately shared by every clone, developer and worktree — **meaning preserved exactly** |
  | **checkout** | `checkout_id = sha256(<absolute git dir>).slice(0, 32)`, `checkout_name = basename(projectRoot)` | **none — derived on demand, never written anywhere** |
  | **contributor** | `sha256(lowercased user.email)` | **none — git already owns it via `user.email`**; documented, derived on demand, **not implemented in this batch** |

  Surface: `getCheckoutIdentity(config): CheckoutIdentity` exported from `src/config.ts` only, with
  `CheckoutIdentity { checkout_id, checkout_name }` in `src/types.ts` and one optional
  `checkout?: CheckoutIdentity` on `MexConfig`. The public surface (`src/index.ts`) is unchanged.
- **Why:**
  - **The scaffold layer is not a bug and must not be "fixed".** `scaffold_id` means *one project*,
    which is exactly what telemetry cohort analysis wants (`TELEMETRY.md:19`, quoted at
    `FLEET-TICKETS/18.md:17`). Changing its scope would silently re-partition every existing cohort.
    Acceptance criterion three is satisfied by leaving `src/config.ts:276-293` alone: the short-circuit
    stays, an existing id keeps its exact meaning, and the new layer is added *beside* it.
  - **Derived beats stored, on the requirement the ticket itself states.** A per-checkout id must be
    untracked. A derived value is untracked **by construction** — there is no file to gitignore, no
    file to accidentally `git add`, no migration for existing scaffolds, and no new env var. Options 2
    and 3 both buy the same answer with strictly more state.
  - `git rev-parse --absolute-git-dir` is already unique per working tree in all three layouts
    (verified above), and stable across runs. Hashing it gives a value that is identical every run for
    a given checkout and distinct for every worktree **and** every clone — including two clones of the
    same repo on one machine, which share `machine_id` *and* `scaffold_id` and were previously
    indistinguishable. Hashing rather than storing the path also keeps a local filesystem path out of
    any structure that might later be serialized.
  - `checkout_name = basename(projectRoot)` finally fixes the cosmetic half of the ticket: a worktree
    at `…/repo-feature-x` reports `repo-feature-x` instead of the frozen `scaffold_name: "repo"`
    (`src/config.ts:285`). It is computed per call, so it cannot go stale the way `scaffold_name` did.
  - **Contributor is deliberately not new state.** git already records the author identity; minting a
    mex-side contributor record would create a second source of truth that can disagree with the
    commits it is supposed to describe. Documenting the derivation (`sha256` of the lowercased
    `user.email`) settles the model — acceptance criterion one asks for the model, not for four
    implementations — and leaves the hashing to whoever first has a use for it.
  - **`origin`/`upstream` are removed, not implemented.** The ticket permits either
    (`FLEET-TICKETS/18.md:32`). The only plausible writer is the git remote URL, and remote URLs can
    embed credentials (`https://user:token@host/…`) while `.mex/config.json` is **committed** — so that
    writer is unsafe by construction and directly contradicts the documented PII firewall at
    `src/telemetry/index.ts:79-80` / `test/telemetry.test.ts:160-166`. Cross-checkout identity is
    already `scaffold_id`, so nothing wants a remote-derived identifier. Removing a field that no
    writer populated (`src/config.ts:286-287` null-defaults it) and no reader consumed is inert in
    practice, and it closes the real liability the ticket names at `FLEET-TICKETS/18.md:26`: dead
    reserved fields in a committed file invite third parties to write to them.
  - **No migration.** `mergeIntoConfig` shallow-merges and preserves unknown keys
    (`src/config.ts:238-252`), so stale `"origin": null` / `"upstream": null` on disk survive
    harmlessly as unread data. Migration code would be more risk than the keys are.
- **What this rules out:**
  - **A checkout identity that survives moving or renaming the checkout directory.** The absolute git
    dir changes, so the `checkout_id` changes. Accepted deliberately: a moved checkout *is* a
    different working context, and this is the price of holding no state.
  - **Any remote-derived or organization-derived identity** in the committed config, now or later —
    that is the whole basis for removing `origin`/`upstream`.
  - **Third-party writes to `origin`/`upstream`.** The fields are gone from `ScaffoldIdentity`, which
    after this change is exactly `scaffold_id: string; scaffold_name: string;`.
  - **Re-scoping `scaffold_id`.** It stays project-wide; anything needing per-context resolution uses
    the checkout layer.
  - **Transmitting the new identity.** `buildPayload` stays six keys
    (`src/telemetry/index.ts:82-97`); adding `checkout_id` to telemetry is a separate decision with a
    separate privacy review.
- **Revisit if:** a feature genuinely needs a checkout identity that survives a directory move (then
  the value has to be stored, and option 2 or 3 comes back with a migration); or a team feature needs
  to correlate checkouts across machines, which needs a shared coordinate the checkout layer
  deliberately does not provide; or `checkout_id` is ever proposed for the telemetry payload, which
  requires reopening the PII firewall at `src/telemetry/index.ts:79-80`.

---

## Dead ends

**Do not skip this.** What you tried that did not work is the most valuable thing in this file — it is what stops the next session from spending the same hours.

| Approach | Why it failed |
|---|---|
| Store the checkout identity in a new **untracked `.mex/checkout.json`** (the shape the ticket itself suggests at `FLEET-TICKETS/18.md:25`). | Needs a `.gitignore` rule to stay untracked, and that rule is **owned by issue #12 in a different lane** — so this ticket would either block on a sibling or duplicate its work. Worse, it puts a file that must *never* be committed inside a directory whose other file (`config.json`) must *always* be committed: a footgun that fails silently and irreversibly, since committing it once shares the "per-checkout" id with every clone forever. The derived value needs no file, so the whole failure mode does not exist. |
| Mint a **random UUID per checkout under `~/.mex/checkouts/<hash-of-path>`**. | Keeps the repo clean, but to find "my" UUID you must key the lookup by the checkout's absolute path — i.e. you already have a unique per-checkout string and are using it to look up a *less* stable one. Then it needs garbage collection for deleted worktrees and clones, or `~/.mex/` grows forever. Strictly more state, more code, and a new failure mode (orphaned registry entries) for exactly the same answer. Rejected. |
| Derive identity from the **git remote URL** (which would also give `origin`/`upstream` their writer). | Two independent disqualifiers. (1) Remote URLs can embed credentials — `https://user:token@host/…` — and `.mex/config.json` is **committed**, so this writes secrets into git history; it contradicts the firewall at `src/telemetry/index.ts:79-80` asserted by `test/telemetry.test.ts:160-166`. (2) It is wrong on the merits anyway: two clones of one repo share a remote, so they would share a "checkout" identity — defeating the entire purpose of the layer. This is why `origin`/`upstream` were removed rather than wired up. |
| Add `checkout_id` to the telemetry payload while touching identity anyway. | Out of scope and a separate decision with its own privacy review. `buildPayload` is a fixed six-key structure (`src/telemetry/index.ts:82-97`) and stays that way; smuggling a new identifier in under an identity-model ticket is exactly how a PII firewall erodes. Explicitly not done. |
| Recompute `scaffold_name` from `basename(projectRoot)` on every load to fix the stale-name complaint at `FLEET-TICKETS/18.md:15`. | Would rewrite a field inside the **committed** config on any checkout whose directory name differs, producing spurious diffs in every worktree and a write race between checkouts. The stale name is a symptom of the missing checkout layer, not of `scaffold_name` — `checkout_name` answers it without mutating committed state. |

---

## Changes made

| File | Change |
|---|---|
| `docs/omp-integration/notes/18-checkout-identity.md` | This note (created). Records Decision B, the `origin`/`upstream` resolution and its §4.3 → §4.2 promotion, and five dead ends. |
| `docs/omp-integration/identity-model.md` | The written identity model required by `FLEET-TICKETS/18.md:31`. Owned by a sibling lane, authored concurrently — not touched here. |
| `src/types.ts` | Owned by the `Identity` lane — adds `CheckoutIdentity`, drops `origin`/`upstream` from `ScaffoldIdentity`, adds `checkout?: CheckoutIdentity` to `MexConfig`. Not authored here. |
| `src/config.ts` | Owned by the `Identity` lane — adds exported `getCheckoutIdentity(config)`, removes the `origin`/`upstream` load/persist/default lines (`:216-217`, `:262-263`, `:286-287`). The `ensureScaffoldIdentity` short-circuit at `:276-293` is preserved. Not authored here. |
| `docs/omp-integration/AGENT-ONBOARDING.md` | Ledger §4.3 `:161` should be struck and restated under §4.2. **Parent lane owns this file — not touched here.** |

## Tests added or changed

| Test | What contract it defends |
|---|---|
| `getCheckoutIdentity` is stable per checkout and distinct across worktrees | That the derived identity is deterministic across runs and actually separates working contexts — the core claim of Decision B. Authored by the `Identity` lane. |
| `checkout_name` tracks the checkout's own directory | That a worktree at `…/repo-feature-x` reports `repo-feature-x`, fixing `FLEET-TICKETS/18.md:15` without touching frozen `scaffold_name` (`src/config.ts:285`). Authored by the `Identity` lane. |
| An existing `scaffold_id` survives untouched | Acceptance criterion three: the `ensureScaffoldIdentity` short-circuit still fires and existing telemetry cohorts keep their meaning. Authored by the `Identity` lane. |
| Config with stale `origin`/`upstream` keys loads without error | That removing the fields needs no migration — `mergeIntoConfig` (`src/config.ts:238-252`) preserves unknown keys. Authored by the `Identity` lane. |
| Telemetry payload key set is unchanged | That no new identifier is transmitted; `buildPayload` stays six keys (`src/telemetry/index.ts:82-97`), and the `origin`/`upstream` exclusion assertion at `test/telemetry.test.ts:160-166` is updated only to reflect that the fields no longer exist. Authored by the `Identity` lane. |
| Nothing new on the public surface | That `src/index.ts` is unchanged — `getCheckoutIdentity` is module-scoped per the batch contract. Authored by the `Identity` lane. |

---

## Verification

- [x] Acceptance criteria all met (all three criteria satisfied)
- [x] Ran the actual thing (output pasted above) (build, test, check, and commit output recorded above)
- [x] `npm test` passes (380 passed, 38 files)
- [x] `npm run build` passes (success; dist/cli.js 317.35 KB, dist/index.js 142.55 KB, dist/index.d.ts 21.66 KB)
- [x] `mex check` did not regress from `94/100` (94/100, 2 warnings, exit 0 — baseline held)
- [x] Docs updated where behavior changed (`identity-model.md` added)
- [x] Any `[INFERENCE]` I resolved was promoted into `AGENT-ONBOARDING.md` §4.2 (resolved, and REPORTED TO THE PARENT for promotion, because the parent owns that file and this lane must not edit it)
- [x] Worktrees / scratch dirs cleaned up (probe worktrees removed and pruned; `git worktree list` = 8 entries, all real fleet lanes; shared `<main>/.git/hooks/post-commit` absent)

```
$ npm run build
ESM dist/index.js     142.55 KB
ESM dist/cli.js     317.35 KB
DTS dist/index.d.ts 21.66 KB
[copy-graph-assets] copied schema.sql + 5 grammar wasm file(s) to dist/

$ npx vitest run
Test Files  38 passed (38)
Tests  380 passed (380)

$ node dist/cli.js check --quiet
mex: drift score 94/100 (2 warnings)
# exit 0 — baseline HELD, no regression
```

## Follow-ups

Adjacent breakage found but deliberately not fixed here. File these as issues; do not silently widen scope.

- [ ] `src/setup/index.ts:68-76` holds a **duplicate, argument-less root resolver** that falls back to `process.cwd()` instead of returning `null` like `findConfig` (`src/config.ts:54-101`). Already recorded in ledger §4.2 (`docs/omp-integration/AGENT-ONBOARDING.md:139`): any root-resolution change must touch both, and the `cwd()` fallback means setup can silently resolve a root where config resolution correctly declines to. Because checkout identity is keyed off the project root, a divergence here yields a different identity depending on which resolver ran. The **ANCHORS lane owns `src/setup/index.ts`**, so this is reported, not fixed here.
- [ ] Ledger §4.3 `:161` (`origin`/`upstream` "purpose unknown") is now resolved and should be promoted into §4.2 with the `e607a55` provenance and the removal decision. **Parent lane owns `AGENT-ONBOARDING.md`.**
- [ ] The **contributor** layer is documented but not implemented (`sha256` of lowercased `user.email`, derived on demand). Worth an issue whenever a feature first needs it, so the derivation is not reinvented differently.
- [ ] Whether `checkout_id` should ever join the telemetry payload is an open, separate decision — `buildPayload` stays six keys (`src/telemetry/index.ts:82-97`) and any change reopens the PII firewall at `src/telemetry/index.ts:79-80`.
- [ ] `checkout_id` does not survive moving or renaming a checkout directory (accepted in Decision B). If a feature ever needs move-stable identity, that is a new ticket with a stored value and a migration.
- [ ] `src/telemetry/index.ts:78-80` still names `origin` and `upstream` in its PII-firewall JSDoc, but this
  lane removed both fields from `ScaffoldIdentity`. The comment is now stale (harmless — it over-warns rather
  than under-warns, and `test/telemetry.test.ts:160-166` still asserts the payload lacks those keys, which
  passes trivially). `src/telemetry/` is outside this lane's OWNED FILES, so it is reported, not edited.
  Whoever owns telemetry should drop the two field names and keep the `scaffold_name` warning.

## Handoff

The model is settled and written down here; the prose deliverable required by
`FLEET-TICKETS/18.md:31` is `docs/omp-integration/identity-model.md`, owned by a sibling lane, and the
code is owned by the `Identity` lane against the batch contract (`CheckoutIdentity` in `src/types.ts`
immediately after `ScaffoldIdentity`, `getCheckoutIdentity` exported from `src/config.ts` only).
Nothing here is blocked.

What a fresh session must not rediscover: `scaffold_id`'s project-wide scope is **intended** — do not
"fix" it, criterion three depends on it. `origin`/`upstream` had no writer and no reader (grep across
`src/ packages/ test/ templates/`), zero mentions in `COMPATIBILITY.md`, and were introduced by
`e607a55`; they are removed with **no migration**, because `mergeIntoConfig` (`src/config.ts:238-252`)
already preserves the stale null keys. The checkout id is derived from
`git rev-parse --absolute-git-dir` and stored nowhere — if you find yourself designing a file to hold
it, re-read the dead ends above first.
