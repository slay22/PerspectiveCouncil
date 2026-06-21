import { $ } from "bun";
import * as fs from "fs/promises";

interface WorktreeTarget {
  worktreePath: string;
}

// ─── Worktree Lifecycle ───────────────────────────────────────────────────────

export async function createWorktrees(
  repoPath: string,
  branch: string,
  panelists: WorktreeTarget[]
): Promise<void> {
  for (const panelist of panelists) {
    const worktreePath = panelist.worktreePath;

    // Remove stale worktree if it exists
    try {
      await fs.access(worktreePath);
      await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet();
    } catch {
      // doesn't exist, that's fine
    }

    // Panelists only read the codebase, so check out the branch tip in a
    // DETACHED worktree. A non-detached `worktree add <path> <branch>` fails
    // when that branch is already checked out (the main working tree, or
    // another panelist), so detaching is both required and correct here.
    await $`git -C ${repoPath} worktree add --detach ${worktreePath} ${branch}`.quiet();
  }
}

export async function removeWorktrees(
  repoPath: string,
  panelists: WorktreeTarget[]
): Promise<void> {
  for (const panelist of panelists) {
    try {
      await $`git -C ${repoPath} worktree remove --force ${panelist.worktreePath}`.quiet();
    } catch {
      // already gone
    }
  }
  await $`git -C ${repoPath} worktree prune`.quiet();
}

export async function createImplementorWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  runId: string
): Promise<string> {
  // Implementor gets its own branch so changes are isolated
  const implBranch = `council/impl-${runId}`;

  try {
    await fs.access(worktreePath);
    await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet();
  } catch {
    // doesn't exist
  }

  // Delete the branch if it already exists from a previous failed run
  await $`git -C ${repoPath} branch -D ${implBranch}`.quiet().nothrow();

  await $`git -C ${repoPath} branch ${implBranch} ${branch}`.quiet();
  await $`git -C ${repoPath} worktree add ${worktreePath} ${implBranch}`.quiet();

  return implBranch;
}

export async function removeImplementorWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  try {
    const branchResult = await $`git -C ${worktreePath} branch --show-current`.text().catch(() => "");
    const branch = branchResult.trim();

    await $`git -C ${repoPath} worktree remove --force ${worktreePath}`.quiet().nothrow();

    if (branch) {
      await $`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
    }
  } catch {
    // already gone
  }
}

export async function getImplementorBranch(worktreePath: string): Promise<string> {
  const result = await $`git -C ${worktreePath} branch --show-current`.text();
  return result.trim();
}
