import { z } from "zod";

// ─── Panelist & Pipeline IDs ────────────────────────────────────────────────

export const PanelistIdSchema = z.enum(["security", "quality", "systems"]);
export type PanelistId = z.infer<typeof PanelistIdSchema>;

export const CliToolSchema = z.enum(["claude", "opencode", "pi"]);
export type CliTool = z.infer<typeof CliToolSchema>;

// ─── Judge Plan ───────────────────────────────────────────────────────────────

export const ActionTypeSchema = z.enum(["create", "modify", "delete", "refactor", "test"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const PrioritySchema = z.enum(["P0", "P1", "P2"]);
export type Priority = z.infer<typeof PrioritySchema>;

// A task's source is usually a panelist, but human-in-the-loop revisions
// inject tasks with the synthetic "hil" source.
export const TaskSourceSchema = z.enum(["security", "quality", "systems", "hil"]);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const PlanTaskSchema = z.object({
  id: z.string().min(1, "Task id is required"),
  file: z.string().min(1, "Task file is required"),
  action: ActionTypeSchema,
  instruction: z.string().min(1, "Task instruction is required"),
  rationale: z.string(),
  priority: PrioritySchema,
  source: z.array(TaskSourceSchema).min(1, "Task must cite at least one source"),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const JudgePlanSchema = z.object({
  summary: z.string().min(1, "Plan summary is required"),
  tasks: z.array(PlanTaskSchema).min(1, "Plan must contain at least one task"),
  riskFlags: z.array(z.string()),
  outOfScope: z.array(z.string()),
});

export type JudgePlan = z.infer<typeof JudgePlanSchema>;

// ─── Validator Report ─────────────────────────────────────────────────────────

export const ValidatorVerdictSchema = z.enum(["PASS", "PARTIAL", "REJECT"]);
export type ValidatorVerdict = z.infer<typeof ValidatorVerdictSchema>;

export const TaskValidationSchema = z.object({
  taskId: z.string().min(1),
  verdict: ValidatorVerdictSchema,
  notes: z.string(),
});

export type TaskValidation = z.infer<typeof TaskValidationSchema>;

export const ValidatorReportSchema = z.object({
  verdict: ValidatorVerdictSchema,
  taskResults: z.array(TaskValidationSchema),
  outOfScopeChanges: z.array(z.string()),
  notes: z.string(),
});

export type ValidatorReport = z.infer<typeof ValidatorReportSchema>;

// ─── HIL Response ─────────────────────────────────────────────────────────────

export const HILDecisionSchema = z.enum([
  "approve",
  "approve_with_notes",
  "revise_plan",
  "revise_implementation",
  "abort",
]);
export type HILDecision = z.infer<typeof HILDecisionSchema>;

// ─── Run Request (UI/Telegram launch) ────────────────────────────────────────

export const RunRequestSchema = z.object({
  repoPath: z.string().min(1, "repoPath is required"),
  branch: z.string().optional(),
  projectContext: z.string().min(1, "projectContext is required"),
  mode: z.enum(["maintenance", "greenfield"]).optional(),
  specPath: z.string().optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const HILResponseSchema = z.object({
  decision: HILDecisionSchema,
  notes: z.string().optional(),
  revisePlanInstructions: z.string().optional(),
  reviseImplInstructions: z.string().optional(),
  reviewer: z.string().min(1, "Reviewer name is required"),
});

export type HILResponse = z.infer<typeof HILResponseSchema>;

// ─── Config ───────────────────────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  tool: CliToolSchema,
  model: z.string().optional(),
  label: z.string().min(1),
  icon: z.string().optional(),
  systemPrompt: z.string().optional(),
  promptFile: z.string().optional(),
}).refine(
  (data) => !!(data.systemPrompt || data.promptFile),
  { message: "Either systemPrompt or promptFile is required" }
);

export const PanelistConfigSchema = AgentConfigSchema.extend({
  id: z.string().min(1),
});

// ─── Forge (PR/MR hosting) ──────────────────────────────────────────────────

export const ForgeProviderSchema = z.enum(["github", "gitlab", "gitea", "azure", "manual"]);
export type ForgeProvider = z.infer<typeof ForgeProviderSchema>;

export const ForgeConfigSchema = z.object({
  provider: ForgeProviderSchema,
  // API/web base, e.g. "https://gitlab.example.com". Defaults per provider.
  baseUrl: z.string().optional(),
  // Repo slug: "owner/name" (github/gitea), "group/sub/project" (gitlab),
  // "org/project/repository" (azure). Inferred from the git remote if omitted.
  repo: z.string().optional(),
  // Env var holding the API token. Defaults per provider (e.g. GITHUB_TOKEN).
  tokenEnv: z.string().optional(),
  // Git remote to push the implementation branch to (default "origin").
  remote: z.string().optional(),
  // Allow using the platform CLI (gh/glab/tea/az) when present (default true).
  cli: z.boolean().optional(),
});
export type ForgeConfig = z.infer<typeof ForgeConfigSchema>;

// ─── Evaluation (build/test/run signal) ──────────────────────────────────────

export const EvaluationConfigSchema = z.object({
  // Off by default. WARNING: when enabled this executes AI-generated code —
  // run it inside the Docker sandbox.
  enabled: z.boolean().optional(),
  install: z.string().optional(),     // e.g. "bun install"
  build: z.string().optional(),       // e.g. "bun run build"
  test: z.string().optional(),        // e.g. "bun test"
  run: z.string().optional(),         // optional smoke command
  cwd: z.string().optional(),         // working dir relative to the worktree
  timeoutMs: z.number().int().positive().optional(),  // per-command timeout
});
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

export const CouncilConfigSchema = z.object({
  panelists: z.array(PanelistConfigSchema).min(1, "At least one panelist is required"),
  judge: AgentConfigSchema,
  validator: AgentConfigSchema,
  forge: ForgeConfigSchema.optional(),
  evaluation: EvaluationConfigSchema.optional(),
});

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type PanelistConfig = z.infer<typeof PanelistConfigSchema>;
