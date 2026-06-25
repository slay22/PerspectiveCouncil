import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CouncilConfigSchema } from "../src/core/schemas.ts";
import { getEmbeddedConfig } from "../src/config-embed.ts";
import type { CouncilConfig, AgentConfig } from "../src/core/schemas.ts";
import type { PipelineMode } from "../src/core/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PanelistConfig extends AgentConfig {
  id: string;
  worktreePath: string;     // injected at load time
  active?: boolean;         // absent === true; conductor filters before runPanel
}

export type { CouncilConfig, AgentConfig };

// ─── Config Path Resolution ───────────────────────────────────────────────────
// When running from source, config lives next to this file (config/panelists.json).
// When running as a compiled binary, import.meta.dir points to a virtual
// filesystem, so we fall back to the current working directory or an env var.

function sourceConfigPath(): string {
  return path.join(import.meta.dir, "panelists.json");
}

function defaultConfigPath(): string {
  if (process.env.COUNCIL_CONFIG_PATH) {
    return path.resolve(process.env.COUNCIL_CONFIG_PATH);
  }
  const cwdConfig = path.join(process.cwd(), "config", "panelists.json");
  if (fs.existsSync(cwdConfig)) return cwdConfig;

  const homeConfig = path.join(os.homedir(), ".config", "perspective-council", "panelists.json");
  if (fs.existsSync(homeConfig)) return homeConfig;

  return cwdConfig;
}

export function resolveConfigPath(configPath?: string): string {
  if (configPath) return path.resolve(configPath);

  const source = sourceConfigPath();
  if (fs.existsSync(source)) return source;

  return defaultConfigPath();
}

// ─── Loader ───────────────────────────────────────────────────────────────────
// Reads panelists.json fresh on every call — no caching.
// Edit the JSON and trigger a new run — changes apply immediately.
// If the requested file does not exist, returns the bundled default config
// (used by compiled binaries that have no sidecar config directory).

export function loadConfig(
  worktreeBase: string,
  runId: string,
  configPath?: string,
  mode: PipelineMode = "maintenance",
): CouncilConfig & { panelists: PanelistConfig[] } {
  const resolvedConfigPath = resolveConfigPath(configPath);
  const useEmbedded = !fs.existsSync(resolvedConfigPath);

  let council: CouncilConfig;
  let configDir: string;

  if (useEmbedded) {
    council = getEmbeddedConfig(mode);
    configDir = process.cwd();
  } else {
    const raw = fs.readFileSync(resolvedConfigPath, "utf-8");
    const json = JSON.parse(raw);
    council = CouncilConfigSchema.parse(json);
    configDir = path.dirname(resolvedConfigPath);
  }

  // Prompt files are resolved relative to the config file's own directory, so a
  // custom --config can ship its own prompts alongside it. In greenfield mode,
  // a sibling `<dir>/greenfield/<name>.md` variant is used when it exists.
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
    // Inactive panelists are kept in the runtime config so the UI can
    // show them in the Config tab, but the conductor filters them out
    // before createWorktrees and runPanel. Absent === active.
    active:       p.active,
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

export function saveConfig(raw: unknown, configPath?: string): void {
  const target = resolveConfigPath(configPath);
  const council = CouncilConfigSchema.parse(raw);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(council, null, 2) + "\n", "utf-8");
}
