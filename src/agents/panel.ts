import { runCLI } from "../core/cli-runner.ts";
import { PanelistIdSchema } from "../core/schemas.ts";
import { serializeCodebase } from "../core/serializer.ts";
import { store } from "../server/store.ts";
import type { PanelResult } from "../core/types.ts";
import type { PanelistConfig } from "../../config/panelists.ts";

export async function runPanel(panelists: PanelistConfig[]): Promise<PanelResult[]> {
  const settled = await Promise.allSettled(panelists.map(runPanelist));
  const results: PanelResult[] = [];

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const panelist = panelists[i];
      if (!panelist) continue;
      store.panelistError(panelist.id, String(outcome.reason));
    }
  }

  store.emit_({ type: "panel_complete", ts: Date.now() });

  if (results.length === 0) {
    throw new Error("All panelists failed; no analysis available.");
  }

  return results;
}

async function runPanelist(panelist: PanelistConfig): Promise<PanelResult> {
  store.panelistStarted(panelist.id);
  store.log("info", `${panelist.label} (${panelist.tool}) reading codebase…`);

  const codebase = await serializeCodebase(panelist.worktreePath);
  store.log("info", `${panelist.label} analyzing (${Math.round(codebase.length / 1000)}k chars)…`);

  const raw = await runCLI({
    tool:         panelist.tool,
    model:        panelist.model,
    systemPrompt: panelist.systemPrompt,
    userMessage:  `Please analyze the following codebase from your expert perspective.\n\n${codebase}`,
    cwd:          panelist.worktreePath,   // run inside the worktree
    label:        panelist.label,
    timeoutMs:    600_000,
  });

  const panelistId = PanelistIdSchema.parse(panelist.id);

  const result: PanelResult = {
    panelistId,
    label:       panelist.label,
    analysis:    raw,
    keyFindings: extractKeyFindings(raw),
    riskLevel:   extractRiskLevel(raw),
  };

  store.panelistDone(panelist.id, result);
  return result;
}

interface StructuredPanelOutput {
  keyFindings: string[];
  riskLevel: PanelResult["riskLevel"];
}

function extractStructuredOutput(analysis: string): Partial<StructuredPanelOutput> {
  const match = analysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (!match) return {};

  try {
    const parsed = JSON.parse(match[1] ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const obj = parsed as Record<string, unknown>;
    const keyFindings = Array.isArray(obj.keyFindings)
      ? obj.keyFindings.filter((f): f is string => typeof f === "string")
      : [];

    const riskLevel = ["low", "medium", "high", "critical"].includes(String(obj.riskLevel))
      ? (String(obj.riskLevel) as PanelResult["riskLevel"])
      : undefined;

    return { keyFindings, riskLevel };
  } catch {
    return {};
  }
}

function extractKeyFindings(analysis: string): string[] {
  const structured = extractStructuredOutput(analysis);
  if (structured.keyFindings && structured.keyFindings.length > 0) {
    return structured.keyFindings.slice(0, 5);
  }

  // Fallback: heuristic extraction from the text body.
  const lines = analysis.split("\n");
  const findings: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (/key findings/i.test(line)) { inSection = true; continue; }
    if (inSection) {
      if (/^#+\s|^\d+\.\s[A-Z]/.test(line) && !line.startsWith("-")) { inSection = false; continue; }
      const clean = line.replace(/^[-•*]\s*/, "").trim();
      if (clean.length > 10) findings.push(clean);
    }
  }
  if (findings.length === 0) {
    for (const line of lines) {
      const clean = line.replace(/^[-•*]\s*/, "").trim();
      if (clean.length > 20 && findings.length < 5) findings.push(clean);
    }
  }
  return findings.slice(0, 5);
}

function extractRiskLevel(analysis: string): PanelResult["riskLevel"] {
  const structured = extractStructuredOutput(analysis);
  if (structured.riskLevel) return structured.riskLevel;

  if (/risk level:\s*critical/i.test(analysis)) return "critical";
  if (/risk level:\s*high/i.test(analysis))     return "high";
  if (/risk level:\s*medium/i.test(analysis))   return "medium";
  if (/risk level:\s*low/i.test(analysis))      return "low";
  const lower = analysis.toLowerCase();
  if ((lower.match(/\bcritical\b/g) ?? []).length > 2) return "critical";
  if ((lower.match(/\bhigh\b/g) ?? []).length > 3)     return "high";
  return "medium";
}
