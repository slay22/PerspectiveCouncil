import { $ } from "bun";
import * as path from "path";
import { runCLI } from "../core/cli-runner.ts";
import { store } from "../server/store.ts";
import type { JudgePlan, PlanTask, PipelineMode } from "../core/types.ts";

export async function runImplementor(
  worktreePath: string,
  plan: JudgePlan,
  mode: PipelineMode = "maintenance",
  parentSignal?: AbortSignal,
): Promise<void> {
  const sorted = [...plan.tasks].sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return order[a.priority] - order[b.priority];
  });

  for (const task of sorted) {
    await executeTask(worktreePath, task, mode, parentSignal);
  }
}

async function executeTask(
  worktreePath: string,
  task: PlanTask,
  mode: PipelineMode,
  parentSignal?: AbortSignal,
): Promise<void> {
  store.taskStarted(task.id);
  store.log("info", `Implementing [${task.priority}] ${task.id}: ${task.action} ${task.file}`);

  try {
    await runCLI({
      tool:         "claude",
      systemPrompt: buildSystemPrompt(worktreePath, task, mode),
      userMessage:  "Implement the task described in your instructions. Work only in the provided directory.",
      cwd:          worktreePath,
      label:        `implementor/${task.id}`,
      timeoutMs:    600_000,
      parentSignal,
      // Limit the implementor to file-editing tools and grant the worktree dir
      // so it can read/write only within the isolated implementation worktree.
      extraArgs:    [
        "--allowedTools", "Edit,Write,Read,MultiEdit",
        "--add-dir", worktreePath,
      ],
    });

    await commitTask(worktreePath, task);
    store.taskDone(task.id);
    store.log("info", `✓ ${task.id} committed`);
  } catch (e) {
    store.taskFailed(task.id, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

function buildSystemPrompt(worktreePath: string, task: PlanTask, mode: PipelineMode): string {
  const header = `You are Claude Code, an implementation agent. You have been given a single, concrete task to perform in a ${mode === "greenfield" ? "new project being built from scratch" : "codebase"}.

Task ID: ${task.id}
Priority: ${task.priority}
File: ${task.file} (full path: ${path.join(worktreePath, task.file)})
Action: ${task.action}
Instruction: ${task.instruction}
Rationale: ${task.rationale}
Source: ${task.source.join(", ")}`;

  const rules = mode === "greenfield"
    ? `RULES:
- Create or modify the specified file to implement the task.
- You may create new files this task requires (configs, modules it imports).
- Do not run shell commands.
- Work only in the provided directory: ${worktreePath}
- Write complete, working code — this is a fresh project with no prior implementation.`
    : `RULES:
- Only modify the specified file.
- Do not run shell commands.
- Do not add extra dependencies.
- Work only in the provided directory: ${worktreePath}
- Prefer minimal, focused changes.`;

  return `${header}\n\n${rules}`;
}

async function commitTask(worktreePath: string, task: PlanTask): Promise<void> {
  await $`git -C ${worktreePath} add ${task.file}`.quiet().nothrow();
  const msg = `[${task.priority}] ${task.id}: ${task.action} ${task.file}\n\n${task.instruction.slice(0, 120)}\n\nRationale: ${task.rationale.slice(0, 200)}\nSource: ${task.source.join(", ")}`;
  await $`git -C ${worktreePath} commit -m ${msg}`.quiet().nothrow();
}