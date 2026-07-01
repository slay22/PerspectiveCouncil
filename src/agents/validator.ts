import { runCLIJSON } from "../core/cli-runner.ts";
import { ValidatorReportSchema } from "../core/schemas.ts";
import { getWorktreeDiff, getChangedFiles } from "../core/diff.ts";
import { formatEvalForValidator } from "../core/evaluate.ts";
import { store } from "../server/store.ts";
import type { EvalResult } from "../core/evaluate.ts";
import type { JudgePlan, ValidatorReport } from "../core/types.ts";
import type { AgentConfig } from "../../config/panelists.ts";

export async function runValidator(
  config: AgentConfig,
  worktreePath: string,
  baseBranch: string,
  plan: JudgePlan,
  evalResult?: EvalResult,
  parentSignal?: AbortSignal,
): Promise<ValidatorReport> {
  store.log("info", `${config.label} (${config.tool}) collecting diff…`);

  const [diff, changedFiles] = await Promise.all([
    getWorktreeDiff(worktreePath, baseBranch),
    getChangedFiles(worktreePath, baseBranch),
  ]);

  if (!diff.trim()) {
    const report: ValidatorReport = {
      verdict: "REJECT",
      taskResults: plan.tasks.map((t) => ({ taskId: t.id, verdict: "REJECT", notes: "No changes found" })),
      outOfScopeChanges: [],
      notes: "Implementation produced no changes.",
    };
    store.setValidatorReport(report);
    return report;
  }

  store.log("info", `${config.label} checking ${changedFiles.length} changed files against ${plan.tasks.length} tasks…`);

  const planSummary = plan.tasks.map((t) =>
    `- ${t.id}: ${t.action} ${t.file} [${t.priority}]\n  Instruction: ${t.instruction}`
  ).join("\n");

  const DIFF_LIMIT = 20_000;
  let diffForPrompt = diff;
  if (diff.length > DIFF_LIMIT) {
    diffForPrompt = diff.slice(0, DIFF_LIMIT) + "\n... [truncated]";
    store.log(
      "warn",
      `Diff is ${Math.round(diff.length / 1000)}k chars — truncated to ${DIFF_LIMIT / 1000}k for the validator, which may miss later changes.`
    );
  }

  const evalSection = evalResult ? formatEvalForValidator(evalResult) : "";

  const report = await runCLIJSON<ValidatorReport>({
    tool:         config.tool,
    model:        config.model,
    systemPrompt: config.systemPrompt,
    userMessage:  `## Judge's Plan\n${planSummary}\n\n## Files Changed\n${changedFiles.join("\n") || "(none)"}\n\n## Git Diff\n\`\`\`diff\n${diffForPrompt}\n\`\`\`\n${evalSection ? `\n${evalSection}\n` : ""}\nValidate plan adherence.`,
    label:        config.label,
    timeoutMs:    300_000,
    parentSignal,
  }, ValidatorReportSchema);

  // A run that fails build/test cannot be a PASS, regardless of plan adherence.
  if (evalResult?.ran && !evalResult.passed && report.verdict === "PASS") {
    report.verdict = "REJECT";
    report.notes = `Build/test failed, so this cannot pass. ${report.notes}`;
    store.log("warn", `${config.label}: overriding PASS → REJECT (build/test failed)`);
  }

  store.setValidatorReport(report);
  store.log(report.verdict === "REJECT" ? "warn" : "info", `${config.label}: ${report.verdict} — ${report.notes}`);
  return report;
}
