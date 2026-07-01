import defaultConfig from "../config/panelists.json" with { type: "json" };
import securityPrompt from "../config/prompts/security.md" with { type: "text" };
import qualityPrompt from "../config/prompts/quality.md" with { type: "text" };
import systemsPrompt from "../config/prompts/systems.md" with { type: "text" };
import judgePrompt from "../config/prompts/judge.md" with { type: "text" };
import validatorPrompt from "../config/prompts/validator.md" with { type: "text" };
import securityGreenfieldPrompt from "../config/prompts/greenfield/security.md" with { type: "text" };
import qualityGreenfieldPrompt from "../config/prompts/greenfield/quality.md" with { type: "text" };
import systemsGreenfieldPrompt from "../config/prompts/greenfield/systems.md" with { type: "text" };

import { CouncilConfigSchema } from "./core/schemas.ts";
import type { CouncilConfig, AgentConfig, PanelistConfig } from "../config/panelists.ts";
import type { PipelineMode } from "./core/types.ts";

const EMBEDDED_DEFAULTS = CouncilConfigSchema.parse(defaultConfig);

const PROMPTS: Record<string, string> = {
  "./prompts/security.md": securityPrompt,
  "./prompts/quality.md": qualityPrompt,
  "./prompts/systems.md": systemsPrompt,
  "./prompts/judge.md": judgePrompt,
  "./prompts/validator.md": validatorPrompt,
  "./prompts/greenfield/security.md": securityGreenfieldPrompt,
  "./prompts/greenfield/quality.md": qualityGreenfieldPrompt,
  "./prompts/greenfield/systems.md": systemsGreenfieldPrompt,
};

function inlinePrompts(agent: AgentConfig, mode: PipelineMode): AgentConfig {
  if (!agent.promptFile) return agent;

  const baseKey = agent.promptFile;
  const greenfieldKey = `./prompts/greenfield/${baseKey.replace(/^\.\/prompts\//, "")}`;

  const prompt = mode === "greenfield" && PROMPTS[greenfieldKey]
    ? PROMPTS[greenfieldKey]
    : PROMPTS[baseKey] ?? "";

  const { promptFile: _omit, ...rest } = agent;
  return { ...rest, systemPrompt: prompt };
}

/** Return the bundled default council configuration with prompt text inlined.
 *  Used when no external panelists.json is provided (e.g. a compiled binary). */
export function getEmbeddedConfig(mode: PipelineMode = "maintenance"): CouncilConfig {
  return {
    panelists: (EMBEDDED_DEFAULTS.panelists as PanelistConfig[]).map((p) => ({
      ...p,
      ...inlinePrompts(p, mode),
    })),
    judge: inlinePrompts(EMBEDDED_DEFAULTS.judge, mode),
    validator: inlinePrompts(EMBEDDED_DEFAULTS.validator, mode),
  };
}
