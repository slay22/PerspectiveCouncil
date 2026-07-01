import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, saveConfig, resolveConfigPath } from "../config/panelists.ts";

// ─── Helper: build a minimal valid config in a temp dir ──────────────────────

async function writeConfig(dir: string, panelistsOverride: unknown): Promise<string> {
  const configPath = path.join(dir, "panelists.json");
  const config = {
    panelists: panelistsOverride,
    judge: { tool: "pi", label: "Judge", systemPrompt: "judge inline" },
    validator: { tool: "claude", label: "Validator", systemPrompt: "validator inline" },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// ─── loadConfig: promptFile escape rejected ──────────────────────────────────

describe("loadConfig promptFile sandbox (LFI guard)", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "council-lfsi-"));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("rejects a promptFile that escapes the config dir during load", async () => {
    await writeConfig(dir, [
      { id: "security", label: "Security", tool: "claude", promptFile: "../../../../etc/passwd" },
      { id: "quality", label: "Quality", tool: "pi", systemPrompt: "inline" },
    ]);
    expect(() => loadConfig("/tmp/wt", "run1", path.join(dir, "panelists.json"))).toThrow(
      /escapes the allowed directory/
    );
  });

  it("rejects an absolute promptFile outside the config dir", async () => {
    await writeConfig(dir, [
      { id: "security", label: "Security", tool: "claude", promptFile: "/etc/passwd" },
      { id: "quality", label: "Quality", tool: "pi", systemPrompt: "inline" },
    ]);
    expect(() => loadConfig("/tmp/wt", "run1", path.join(dir, "panelists.json"))).toThrow(
      /escapes the allowed directory/
    );
  });

  it("still allows a legitimate sibling promptFile", async () => {
    await fs.promises.mkdir(path.join(dir, "prompts"), { recursive: true });
    await fs.promises.writeFile(path.join(dir, "prompts", "sec.md"), "PROMPT");
    await writeConfig(dir, [
      { id: "security", label: "Security", tool: "claude", promptFile: "./prompts/sec.md" },
      { id: "quality", label: "Quality", tool: "pi", systemPrompt: "inline" },
    ]);
    const council = loadConfig("/tmp/wt", "run1", path.join(dir, "panelists.json"));
    expect(council.panelists[0]?.systemPrompt).toBe("PROMPT");
  });
});

// ─── saveConfig: promptFile escape rejected at save time ─────────────────────

describe("saveConfig promptFile sandbox", () => {
  let originalContent = "";
  let cleanup = false;

  beforeEach(() => {
    originalContent = fs.readFileSync(resolveConfigPath(), "utf-8");
  });

  afterEach(() => {
    if (cleanup) {
      fs.writeFileSync(resolveConfigPath(), originalContent, "utf-8");
      cleanup = false;
    }
  });

  it("rejects an escaping promptFile before writing to disk", () => {
    cleanup = true;
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude", systemPrompt: "inline a" },
        { id: "b", label: "B", tool: "pi", systemPrompt: "inline b" },
      ],
      judge: { tool: "pi", label: "Judge", systemPrompt: "judge inline" },
      validator: { tool: "claude", label: "Validator", promptFile: "../../../../etc/passwd" },
    };
    expect(() => saveConfig(config)).toThrow(/escapes the allowed directory/);
  });

  it("still saves a valid config", () => {
    cleanup = true;
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude", systemPrompt: "inline a" },
        { id: "b", label: "B", tool: "pi", systemPrompt: "inline b" },
      ],
      judge: { tool: "pi", label: "Judge", systemPrompt: "judge inline" },
      validator: { tool: "claude", label: "Validator", systemPrompt: "validator inline" },
    };
    expect(() => saveConfig(config)).not.toThrow();
  });
});