import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  createWorktrees,
  removeWorktrees,
  createImplementorWorktree,
  removeImplementorWorktree,
  getImplementorBranch,
} from "../src/core/worktree.ts";

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function branchExists(repo: string, name: string): Promise<boolean> {
  const out = await $`git -C ${repo} branch --list ${name}`.text();
  return out.trim().length > 0;
}

describe("worktree lifecycle", () => {
  let repo = "";
  let base = "";

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "council-repo-"));
    base = await fs.mkdtemp(path.join(os.tmpdir(), "council-wt-"));
    await $`git -C ${repo} init -b main`.quiet();
    await $`git -C ${repo} config user.email test@example.com`.quiet();
    await $`git -C ${repo} config user.name Test`.quiet();
    await fs.writeFile(path.join(repo, "README.md"), "# test\n");
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -m init`.quiet();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  it("creates and removes panelist worktrees", async () => {
    const panelists = [
      { worktreePath: path.join(base, "council-run-security") },
      { worktreePath: path.join(base, "council-run-quality") },
    ];

    await createWorktrees(repo, "main", panelists);
    for (const p of panelists) {
      expect(await exists(path.join(p.worktreePath, "README.md"))).toBe(true);
    }

    await removeWorktrees(repo, panelists);
    for (const p of panelists) {
      expect(await exists(p.worktreePath)).toBe(false);
    }
  });

  it("creates an implementor worktree on its own branch and cleans it up", async () => {
    const implPath = path.join(base, "council-impl-run1");
    const implBranch = await createImplementorWorktree(repo, "main", implPath, "run1");

    expect(implBranch).toBe("council/impl-run1");
    expect(await exists(implPath)).toBe(true);
    expect(await branchExists(repo, implBranch)).toBe(true);
    expect(await getImplementorBranch(implPath)).toBe(implBranch);

    await removeImplementorWorktree(repo, implPath);
    expect(await exists(implPath)).toBe(false);
    // The implementation branch must not leak after cleanup.
    expect(await branchExists(repo, implBranch)).toBe(false);
  });

  it("recreates an implementor worktree when a stale one exists", async () => {
    const implPath = path.join(base, "council-impl-run2");
    await createImplementorWorktree(repo, "main", implPath, "run2");
    // Calling again with the same runId should not throw (stale cleanup path).
    const branch = await createImplementorWorktree(repo, "main", implPath, "run2");
    expect(branch).toBe("council/impl-run2");
    expect(await exists(implPath)).toBe(true);

    await removeImplementorWorktree(repo, implPath);
  });
});
