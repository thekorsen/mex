import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_COMMIT_COUNT_MODE,
  commitsSinceLastChange,
  commitsTouchingPaths,
  getGitDiff,
  resolveComparisonBase,
} from "../src/git.js";

const roots: string[] = [];

function createRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MEX_TELEMETRY: "0" },
  }).trim();
}

function initRepo(root: string): void {
  git(["-c", "init.defaultBranch=main", "init"], root);
}

function commitAll(root: string, message: string): void {
  git(["add", "."], root);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    message,
  ], root);
}

function write(root: string, relativePath: string, content: string): void {
  writeFileSync(join(root, relativePath), content);
}

beforeAll(() => {
  process.env.MEX_TELEMETRY = "0";
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("git upstream resolution and counting", () => {
  it("degrades safely in a zero-commit repo", async () => {
    const root = createRepo("mex-git-zero-");
    initRepo(root);

    await expect(resolveComparisonBase(root)).resolves.toMatchObject({
      source: "local",
      ref: null,
    });
    await expect(commitsSinceLastChange("README.md", root)).resolves.toBeNull();
  });

  it("uses a local fallback note when no remote exists after one commit", async () => {
    const root = createRepo("mex-git-single-");
    initRepo(root);
    write(root, "README.md", "hello\n");
    commitAll(root, "seed");

    const base = await resolveComparisonBase(root);

    expect(base.source).toBe("local");
    expect(base.ref).toBeNull();
    expect(base.note).not.toBeNull();
    await expect(commitsSinceLastChange("README.md", root)).resolves.toBe(0);
    await expect(commitsSinceLastChange("MISSING.md", root)).resolves.toBeNull();
  });

  it("falls through cleanly from detached HEAD to a coherent comparison base", async () => {
    const source = createRepo("mex-git-detached-src-");
    initRepo(source);
    write(source, "README.md", "base\n");
    commitAll(source, "base");
    write(source, "README.md", "base\nnext\n");
    commitAll(source, "next");

    const clone = createRepo("mex-git-detached-clone-");
    git(["clone", `file://${source}`, clone], ".");
    git(["checkout", "--detach", "HEAD"], clone);

    const base = await resolveComparisonBase(clone);

    expect(base.source === "remote-head" || base.source === "local").toBe(true);
    expect(base.shallow).toBe(false);
    expect(base.ref === null || typeof base.ref === "string").toBe(true);
    expect(base.mergeBase === null || typeof base.mergeBase === "string").toBe(true);
    expect(base.ahead === null || typeof base.ahead === "number").toBe(true);
    expect(base.behind === null || typeof base.behind === "number").toBe(true);
  });

  it("marks shallow clones as lower-bound comparisons without throwing", async () => {
    const source = createRepo("mex-git-shallow-src-");
    initRepo(source);
    write(source, "notes.md", "one\n");
    commitAll(source, "one");
    write(source, "notes.md", "one\ntwo\n");
    commitAll(source, "two");
    write(source, "notes.md", "one\ntwo\nthree\n");
    commitAll(source, "three");

    const clone = createRepo("mex-git-shallow-clone-");
    git(["clone", "--depth", "1", `file://${source}`, clone], ".");

    const base = await resolveComparisonBase(clone);
    const count = await commitsSinceLastChange("notes.md", clone);

    expect(base.shallow).toBe(true);
    expect(base.note).not.toBeNull();
    expect(count).not.toBeNull();
    expect(typeof count).toBe("number");
  });

  it("counts merge commits only in all mode and defaults to no-merges", async () => {
    const root = createRepo("mex-git-merge-");
    initRepo(root);
    write(root, "knowledge.md", "seed\n");
    commitAll(root, "knowledge");

    git(["checkout", "-b", "feature"], root);
    write(root, "feature-a.txt", "a\n");
    commitAll(root, "feature a");
    write(root, "feature-b.txt", "b\n");
    commitAll(root, "feature b");

    git(["checkout", "main"], root);
    write(root, "main.txt", "main\n");
    commitAll(root, "main work");
    git([
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "merge",
      "--no-ff",
      "feature",
      "-m",
      "merge feature",
    ], root);

    const all = await commitsSinceLastChange("knowledge.md", root, { mode: "all" });
    const noMerges = await commitsSinceLastChange("knowledge.md", root, { mode: "no-merges" });
    const defaultMode = await commitsSinceLastChange("knowledge.md", root);

    expect(all).not.toBeNull();
    expect(noMerges).not.toBeNull();
    expect(defaultMode).toBe(noMerges);
    expect(DEFAULT_COMMIT_COUNT_MODE).toBe("no-merges");
    expect(all).toBeGreaterThan(noMerges as number);
    expect((all as number) - (noMerges as number)).toBe(1);
  });

  it("still resolves a count for a file that was renamed", async () => {
    const root = createRepo("mex-git-rename-");
    initRepo(root);
    write(root, "old-name.md", "v1\n");
    commitAll(root, "add old name");
    git(["mv", "old-name.md", "new-name.md"], root);
    commitAll(root, "rename file");
    write(root, "other.txt", "later\n");
    commitAll(root, "later one");
    write(root, "another.txt", "later again\n");
    commitAll(root, "later two");

    // The rename commit itself touches the new path, so the file's last commit
    // IS the rename — two commits land after it. The regression this guards is
    // returning null (losing the file's identity across the rename) rather than
    // an off-by-one: `--follow` is a no-op for a `-1` lookup and only changes
    // full-history walks, so a renamed file must still produce a real number.
    await expect(commitsSinceLastChange("new-name.md", root)).resolves.toBe(2);
  });

  // Spawns several real git repos; ~6.5s locally, and CI has fewer cores than a
  // dev box, so the 5s default is marginal by construction rather than flaky code.
  it("diffs against the resolved base instead of a hardcoded HEAD~5 window", { timeout: 15000 }, async () => {
    const source = createRepo("mex-git-diff-src-");
    initRepo(source);
    write(source, "knowledge.md", "base\n");
    commitAll(source, "base");

    const clone = createRepo("mex-git-diff-clone-");
    git(["clone", `file://${source}`, clone], ".");

    write(source, "knowledge.md", "base\nupstream\n");
    commitAll(source, "upstream change");

    git(["checkout", "-b", "feature"], clone);
    write(clone, "knowledge.md", "base\nfeature-1\n");
    commitAll(clone, "feature 1");
    write(clone, "knowledge.md", "base\nfeature-1\nfeature-2\n");
    commitAll(clone, "feature 2");
    write(clone, "knowledge.md", "base\nfeature-1\nfeature-2\nfeature-3\n");
    commitAll(clone, "feature 3");
    write(clone, "knowledge.md", "base\nfeature-1\nfeature-2\nfeature-3\nfeature-4\n");
    commitAll(clone, "feature 4");
    write(clone, "knowledge.md", "base\nfeature-1\nfeature-2\nfeature-3\nfeature-4\nfeature-5\n");
    commitAll(clone, "feature 5");
    write(clone, "knowledge.md", "base\nfeature-1\nfeature-2\nfeature-3\nfeature-4\nfeature-5\nfeature-6\n");
    commitAll(clone, "feature 6");

    const base = await resolveComparisonBase(clone);
    const diff = await getGitDiff(["knowledge.md"], clone);

    expect(base.mergeBase).not.toBeNull();
    expect(diff).toContain("feature-1");
    expect(diff).toContain("feature-6");

    const small = createRepo("mex-git-diff-small-");
    initRepo(small);
    write(small, "tiny.md", "one\n");
    commitAll(small, "one");
    write(small, "tiny.md", "one\ntwo\n");
    commitAll(small, "two");

    await expect(getGitDiff(["tiny.md"], small)).resolves.toEqual(expect.any(String));
  });

  it("includes uncommitted work in the diff, not just committed history", async () => {
    // `mex sync`'s brief (src/sync/brief-builder.ts:106) is getGitDiff's only
    // consumer: it shows an agent what changed about the paths a page claims.
    // Work in progress is exactly what matters there, so a two-dot
    // `<base>..HEAD` range — which omits the working tree — is wrong. This
    // caught a real bug: the diff came back empty for a heavily edited file.
    const source = createRepo("mex-git-dirty-src-");
    initRepo(source);
    write(source, "knowledge.md", "base\n");
    commitAll(source, "base");

    const clone = createRepo("mex-git-dirty-clone-");
    git(["clone", `file://${source}`, clone], ".");

    write(clone, "knowledge.md", "base\ncommitted-change\n");
    commitAll(clone, "committed change");
    // Never committed — only a working-tree edit.
    write(clone, "knowledge.md", "base\ncommitted-change\nuncommitted-change\n");

    const diff = await getGitDiff(["knowledge.md"], clone);
    expect(diff).toContain("uncommitted-change");
    expect(diff).toContain("committed-change");
  });

  it("reports a human-readable ref rather than a refs/remotes/ path", async () => {
    // The ref reaches users inside STALE_FILE messages, so "origin/main" is the
    // contract, not "refs/remotes/origin/main".
    const source = createRepo("mex-git-refname-src-");
    initRepo(source);
    write(source, "knowledge.md", "base\n");
    commitAll(source, "base");

    const clone = createRepo("mex-git-refname-clone-");
    git(["clone", `file://${source}`, clone], ".");

    const base = await resolveComparisonBase(clone);
    expect(base.ref).not.toBeNull();
    expect(base.ref).not.toContain("refs/remotes/");
    expect(base.ref).toMatch(/^origin\//);
  });

  it("counts commits that landed UPSTREAM, not commits on our own branch", async () => {
    // The regression this guards is the whole point of issue #9: "what landed
    // upstream that my knowledge does not reflect?". A `mergeBase..HEAD` range
    // counts OUR commits and returns 0 for a checkout that is behind, which is
    // precisely the situation the feature exists to report. A mocked unit test
    // cannot catch this — it has no opinion about which ref is correct — so the
    // assertion has to run against real git.
    const source = createRepo("mex-git-upstream-dir-src-");
    initRepo(source);
    write(source, "app.ts", "v0\n");
    commitAll(source, "base");

    const clone = createRepo("mex-git-upstream-dir-clone-");
    git(["clone", `file://${source}`, clone], ".");

    // Three commits land upstream, touching the claimed file. Our clone does
    // nothing at all, so HEAD stays exactly at the merge base.
    for (const n of [1, 2, 3]) {
      write(source, "app.ts", `v0\nupstream-${n}\n`);
      commitAll(source, `upstream ${n}`);
    }
    git(["fetch", "origin"], clone);

    const base = await resolveComparisonBase(clone);
    expect(base.ref).not.toBeNull();
    expect(base.mergeBase).not.toBeNull();
    expect(base.behind).toBe(3);

    // Counting toward the upstream ref sees all three.
    await expect(
      commitsTouchingPaths(["app.ts"], base.mergeBase!, clone, { until: base.ref! }),
    ).resolves.toBe(3);

    // Counting toward HEAD sees none — the bug this test exists to prevent.
    await expect(
      commitsTouchingPaths(["app.ts"], base.mergeBase!, clone),
    ).resolves.toBe(0);
  });
});
