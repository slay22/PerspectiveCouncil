import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { loadConfig } from "../config/panelists.ts";

describe("loadConfig with a custom --config path", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-cfg-"));
    await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
    await fs.writeFile(path.join(dir, "prompts", "sec.md"), "CUSTOM SECURITY PROMPT");
    const config = {
      panelists: [
        { id: "security", label: "Security", tool: "claude", promptFile: "./prompts/sec.md" },
        { id: "quality",  label: "Quality",  tool: "pi",     systemPrompt: "quality inline" },
      ],
      judge: { tool: "pi", label: "Judge", systemPrompt: "judge inline" },
      validator: { tool: "claude", label: "Validator", systemPrompt: "validator inline" },
    };
    await fs.writeFile(path.join(dir, "panelists.json"), JSON.stringify(config));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves promptFile relative to the config file's directory", () => {
    const council = loadConfig("/tmp/wt-base", "run1", path.join(dir, "panelists.json"));
    expect(council.panelists[0]?.systemPrompt).toBe("CUSTOM SECURITY PROMPT");
    expect(council.judge.systemPrompt).toBe("judge inline");
  });

  it("scopes worktree paths by runId", () => {
    const council = loadConfig("/tmp/wt-base", "abc123", path.join(dir, "panelists.json"));
    expect(council.panelists[0]?.worktreePath).toBe(
      path.join("/tmp/wt-base", "council-abc123-security")
    );
  });
});
