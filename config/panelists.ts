import * as fs from "fs";
import * as path from "path";
import { CouncilConfigSchema } from "../src/core/schemas.ts";
import type { CouncilConfig, AgentConfig } from "../src/core/schemas.ts";
import type { PipelineMode } from "../src/core/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PanelistConfig extends AgentConfig {
  id: string;
  worktreePath: string;     // injected at load time
}

export type { CouncilConfig, AgentConfig };

// ─── Loader ───────────────────────────────────────────────────────────────────
// Reads panelists.json fresh on every call — no caching.
// Edit the JSON and trigger a new run — changes apply immediately.

export const CONFIG_PATH = path.join(import.meta.dir, "panelists.json");

export function loadConfig(
  worktreeBase: string,
  runId: string,
  configPath: string = CONFIG_PATH,
  mode: PipelineMode = "maintenance",
): CouncilConfig & { panelists: PanelistConfig[] } {
  const resolvedConfigPath = path.resolve(configPath);
  const raw  = fs.readFileSync(resolvedConfigPath, "utf-8");
  const json = JSON.parse(raw);

  const council = CouncilConfigSchema.parse(json);

  // Prompt files are resolved relative to the config file's own directory, so a
  // custom --config can ship its own prompts alongside it. In greenfield mode,
  // a sibling `<dir>/greenfield/<name>.md` variant is used when it exists.
  const configDir = path.dirname(resolvedConfigPath);
  const resolvePrompt = (agent: { systemPrompt?: string; promptFile?: string }): string => {
    if (agent.promptFile) {
      let filePath = path.resolve(configDir, agent.promptFile);
      if (mode === "greenfield") {
        const variant = path.join(path.dirname(filePath), "greenfield", path.basename(filePath));
        if (fs.existsSync(variant)) filePath = variant;
      }
      return fs.readFileSync(filePath, "utf-8");
    }
    return agent.systemPrompt ?? "";
  };

  const panelists: PanelistConfig[] = council.panelists.map((p) => ({
    id:           p.id,
    label:        p.label,
    icon:         p.icon ?? "🤖",
    tool:         p.tool,
    model:        p.model,
    systemPrompt: resolvePrompt(p),
    worktreePath: path.join(worktreeBase, `council-${runId}-${p.id}`),
  }));

  return {
    panelists,
    judge:      { ...council.judge,     systemPrompt: resolvePrompt(council.judge) },
    validator:  { ...council.validator, systemPrompt: resolvePrompt(council.validator) },
    forge:      council.forge,
    evaluation: council.evaluation,
  };
}

// ─── Save Config ──────────────────────────────────────────────────────────────
// Writes a raw CouncilConfig back to panelists.json after validation.
// This is used by the web config editor.

export function saveConfig(raw: unknown): void {
  const council = CouncilConfigSchema.parse(raw);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(council, null, 2) + "\n", "utf-8");
}
