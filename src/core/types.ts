import type {
  PanelistId,
  ActionType,
  Priority,
  PlanTask,
  JudgePlan,
  ValidatorVerdict,
  TaskValidation,
  ValidatorReport,
  HILDecision,
  HILResponse,
} from "./schemas.ts";

// Re-export validated types
export type {
  PanelistId,
  ActionType,
  Priority,
  PlanTask,
  JudgePlan,
  ValidatorVerdict,
  TaskValidation,
  ValidatorReport,
  HILDecision,
  HILResponse,
};

// ─── Panelist Runtime Model ───────────────────────────────────────────────────

export interface Panelist {
  id: PanelistId;
  label: string;
  icon: string;
  model: string;
  baseURL?: string;           // OpenAI-compatible endpoint (Minimax, Kimi)
  apiKeyEnv: string;          // env var name for the API key
  systemPrompt: string;
  worktreePath: string;
}

// ─── Panel Results ────────────────────────────────────────────────────────────

export interface PanelResult {
  panelistId: PanelistId;
  label: string;
  analysis: string;
  keyFindings: string[];      // extracted bullet points
  riskLevel: "low" | "medium" | "high" | "critical";
}

// ─── Pipeline Mode ────────────────────────────────────────────────────────────

export type PipelineMode = "maintenance" | "greenfield";

// ─── Pipeline State ───────────────────────────────────────────────────────────

export type PipelineStage =
  | "init"
  | "worktrees"
  | "panel"
  | "judge"
  | "implement"
  | "validate"
  | "hil"
  | "pr"
  | "done"
  | "aborted";

export interface PipelineRun {
  id: string;
  repoPath: string;
  branch: string;
  stage: PipelineStage;
  startedAt: Date;

  panelResults?: PanelResult[];
  judgePlan?: JudgePlan;
  validatorReport?: ValidatorReport;
  hilResponse?: HILResponse;
  prUrl?: string;

  // for reject loops
  iterations: number;
  maxIterations: number;
}
