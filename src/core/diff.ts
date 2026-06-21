import { $ } from "bun";

// ─── Diff Helpers ─────────────────────────────────────────────────────────────

export async function getWorktreeDiff(
  worktreePath: string,
  baseBranch: string
): Promise<string> {
  const result = await $`git -C ${worktreePath} diff ${baseBranch}...HEAD`.text();
  return result;
}

export async function getChangedFiles(
  worktreePath: string,
  baseBranch: string
): Promise<string[]> {
  const result = await $`git -C ${worktreePath} diff --name-only ${baseBranch}...HEAD`.text();
  return result.trim().split("\n").filter(Boolean);
}
