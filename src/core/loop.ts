import type { JudgePlan, ValidatorReport, ValidatorVerdict } from "./types.ts";

// Pure helpers for the converging judge → implement → validate loop.

/** Stable signature of a plan's task set, so two iterations can be compared. */
export function planSignature(plan: JudgePlan): string {
  return plan.tasks
    .map((t) => `${t.id}:${t.action}:${t.file}`)
    .sort()
    .join("|");
}

const VERDICT_RANK: Record<ValidatorVerdict, number> = { REJECT: 0, PARTIAL: 1, PASS: 2 };

/** True if the current verdict is strictly better than the previous one. */
export function verdictImproved(prev: ValidatorVerdict | undefined, curr: ValidatorVerdict): boolean {
  if (prev === undefined) return true;
  return VERDICT_RANK[curr] > VERDICT_RANK[prev];
}

/**
 * No progress = the judge produced the same plan as last time AND the validator
 * verdict did not improve. When that happens, retrying again is pointless — stop
 * and escalate to a human instead of burning iterations.
 */
export function isStalled(args: {
  prevPlanSig: string | undefined;
  currPlanSig: string;
  prevVerdict: ValidatorVerdict | undefined;
  currVerdict: ValidatorVerdict;
}): boolean {
  const samePlan = args.prevPlanSig !== undefined && args.prevPlanSig === args.currPlanSig;
  const noImprovement = !verdictImproved(args.prevVerdict, args.currVerdict);
  return samePlan && noImprovement;
}

/** Render a validator report as feedback the judge can act on next iteration. */
export function formatValidatorFeedback(report: ValidatorReport): string {
  const perTask = report.taskResults
    .map((t) => `- ${t.taskId}: ${t.verdict} — ${t.notes}`)
    .join("\n");
  const outOfScope = report.outOfScopeChanges.length
    ? `\n\nOut-of-scope changes flagged:\n${report.outOfScopeChanges.map((s) => `- ${s}`).join("\n")}`
    : "";
  return `Overall verdict: ${report.verdict}\n${report.notes}\n\nPer-task results:\n${perTask}${outOfScope}`;
}
