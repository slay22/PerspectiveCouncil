import { runCLIJSON } from "../core/cli-runner.ts";
import { JudgePlanSchema } from "../core/schemas.ts";
import { store } from "../server/store.ts";
import type { PanelResult, JudgePlan } from "../core/types.ts";
import type { AgentConfig } from "../../config/panelists.ts";

export async function runJudge(
  config: AgentConfig,
  originalPrompt: string,
  panelResults: PanelResult[],
  revisionNotes?: string,
  validatorFeedback?: string
): Promise<JudgePlan> {
  store.emit_({ type: "judge_started", ts: Date.now() });
  store.log("info", `${config.label} (${config.tool}) reading panel reports…`);

  const sections = panelResults.map((r) =>
    `## ${r.label} (Risk: ${r.riskLevel.toUpperCase()})\n\n${r.analysis}`
  ).join("\n---\n");

  const revisionSection = revisionNotes
    ? `\n## HUMAN REVISION NOTES\n${revisionNotes}\n`
    : "";

  // On a retry, the previous plan failed validation. Surface those findings so
  // the new plan addresses them instead of repeating the same mistakes.
  const feedbackSection = validatorFeedback
    ? `\n## PREVIOUS ATTEMPT — VALIDATOR FINDINGS\nYour previous plan did not fully pass validation. Revise the plan to address these findings before anything else:\n${validatorFeedback}\n`
    : "";

  const plan = await runCLIJSON<JudgePlan>({
    tool:         config.tool,
    model:        config.model,
    systemPrompt: config.systemPrompt,
    userMessage:  `## Project Context\n${originalPrompt}\n\n---\n\n## Panel Analyses\n${sections}\n${revisionSection}${feedbackSection}\n---\n\nNow produce the implementation plan JSON.`,
    label:        config.label,
    timeoutMs:    600_000,
  }, JudgePlanSchema);

  store.setJudgePlan(plan);
  store.log("info", `${config.label} produced ${plan.tasks.length} tasks (${plan.riskFlags.length} risk flags)`);
  return plan;
}
