import * as path from "path";
import type { EvaluationConfig } from "./schemas.ts";

// Runs configured build/test/run commands in the implementation worktree to
// produce a concrete "does it actually work?" signal for the validator/loop.
//
// SECURITY: this executes code the agents generated. Only enable it inside a
// sandbox (the project's Docker image).

export type EvalStep = "install" | "build" | "test" | "run";

export interface EvalStepResult {
  step: EvalStep;
  command: string;
  ok: boolean;
  exitCode: number | null;   // null = timed out / aborted
  output: string;            // combined stdout+stderr, truncated
  skipped?: boolean;         // skipped because an earlier step failed
}

export interface EvalResult {
  ran: boolean;              // at least one command executed
  passed: boolean;           // every executed step succeeded
  steps: EvalStepResult[];
}

const STEP_ORDER: EvalStep[] = ["install", "build", "test", "run"];
const OUTPUT_LIMIT = 4000;

export async function runEvaluation(
  worktreePath: string,
  config: EvaluationConfig,
  parentSignal?: AbortSignal,
): Promise<EvalResult> {
  if (config.enabled === false) return { ran: false, passed: true, steps: [] };

  const cwd = config.cwd ? path.join(worktreePath, config.cwd) : worktreePath;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const steps: EvalStepResult[] = [];
  let failed = false;

  for (const step of STEP_ORDER) {
    const command = config[step];
    if (typeof command !== "string" || command.trim() === "") continue;

    if (failed) {
      steps.push({ step, command, ok: false, exitCode: null, output: "", skipped: true });
      continue;
    }

    // A run-level cancel aborts the whole evaluation immediately.
    if (parentSignal?.aborted) {
      steps.push({ step, command, ok: false, exitCode: null, output: "[cancelled]", skipped: true });
      failed = true;
      continue;
    }

    const res = await runCommand(command, cwd, timeoutMs, parentSignal);
    steps.push({ step, command, ...res });
    if (!res.ok) failed = true;
  }

  const ran = steps.some((s) => !s.skipped);
  return { ran, passed: ran && !failed, steps };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  let timedOut = false;
  let cancelled = false;
  let proc;
  try {
    proc = Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, exitCode: null, output: `failed to start: ${e instanceof Error ? e.message : String(e)}` };
  }

  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  const onAbort = () => { cancelled = true; try { proc.kill(); } catch { /* exited */ } };
  if (parentSignal) {
    if (parentSignal.aborted) { cancelled = true; proc.kill(); }
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    // Drain stdout/stderr CONCURRENTLY with exit so a verbose build (> pipe
    // buffer) can't deadlock us.
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = truncate((stdout + stderr).trim() + (timedOut ? "\n[timed out]" : "") + (cancelled ? "\n[cancelled]" : ""));
    return { ok: exitCode === 0 && !timedOut && !cancelled, exitCode: (timedOut || cancelled) ? null : exitCode, output };
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

function truncate(s: string): string {
  return s.length > OUTPUT_LIMIT ? s.slice(0, OUTPUT_LIMIT) + "\n… [truncated]" : s;
}

/** Render an evaluation result for the validator prompt. */
export function formatEvalForValidator(result: EvalResult): string {
  if (!result.ran) return "";
  const lines = result.steps.map((s) => {
    if (s.skipped) return `- ${s.step}: SKIPPED (earlier step failed)`;
    const status = s.ok ? "OK" : `FAILED (exit ${s.exitCode ?? "timeout"})`;
    const tail = s.ok ? "" : `\n  \`${s.command}\`\n  ${s.output.split("\n").slice(-20).join("\n  ")}`;
    return `- ${s.step}: ${status}${tail}`;
  });
  return `## Build / Test Results (${result.passed ? "PASSED" : "FAILED"})\n${lines.join("\n")}`;
}
