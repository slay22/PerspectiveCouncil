import { $ } from "bun";
import * as fs from "fs/promises";
import * as path from "path";
import { writeTempFile } from "../core/cli-runner.ts";
import { store } from "../server/store.ts";
import type { JudgePlan, PlanTask } from "../core/types.ts";

export async function runImplementor(worktreePath: string, plan: JudgePlan): Promise<void> {
  const sorted = [...plan.tasks].sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return order[a.priority] - order[b.priority];
  });

  for (const task of sorted) {
    await executeTask(worktreePath, task);
  }
}

async function executeTask(worktreePath: string, task: PlanTask): Promise<void> {
  store.taskStarted(task.id);
  store.log("info", `Implementing [${task.priority}] ${task.id}: ${task.action} ${task.file}`);

  const systemFile = await writeTempFile(buildSystemPrompt(worktreePath, task), `task-${task.id}`);

  try {
    const result = await $`claude \
      --print \
      --no-interactive \
      --allowedTools "Edit,Write,Read,MultiEdit" \
      --add-dir ${worktreePath} \
      --system-prompt ${systemFile} \
      "Implement the task described in your instructions. Work only in the provided directory."`
      .cwd(worktreePath)
      .nothrow();

    if (result.exitCode !== 0) {
      store.taskFailed(task.id, result.stderr.toString());
      throw new Error(`Claude Code failed on ${task.id}: ${result.stderr}`);
    }

    await commitTask(worktreePath, task);
    store.taskDone(task.id);
    store.log("info", `✓ ${task.id} committed`);
  } finally {
    await fs.unlink(systemFile).catch(() => {});
  }
}

function buildSystemPrompt(worktreePath: string, task: PlanTask): string {
  return `You are Claude Code, an implementation agent. You have been given a single, concrete task to perform in a codebase.

Task ID: ${task.id}
Priority: ${task.priority}
File: ${task.file} (full path: ${path.join(worktreePath, task.file)})
Action: ${task.action}
Instruction: ${task.instruction}
Rationale: ${task.rationale}
Source panelists: ${task.source.join(", ")}

RULES:
- Only modify the specified file.
- Do not run shell commands.
- Do not add extra dependencies.
- Work only in the provided directory: ${worktreePath}
- Prefer minimal, focused changes.`;
}

async function commitTask(worktreePath: string, task: PlanTask): Promise<void> {
  await $`git -C ${worktreePath} add ${task.file}`.quiet().nothrow();
  const msg = `[${task.priority}] ${task.id}: ${task.action} ${task.file}\n\n${task.instruction.slice(0, 120)}\n\nRationale: ${task.rationale.slice(0, 200)}\nSource: ${task.source.join(", ")}`;
  await $`git -C ${worktreePath} commit -m ${msg}`.quiet().nothrow();
}
