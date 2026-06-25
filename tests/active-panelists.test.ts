import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { saveConfig, loadConfig, resolveConfigPath } from "../config/panelists.ts";
import { CouncilConfigSchema } from "../src/core/schemas.ts";

const validBase = {
  judge: { tool: "pi" as const, label: "Judge", systemPrompt: "j" },
  validator: { tool: "claude" as const, label: "Validator", systemPrompt: "v" },
};

describe("CouncilConfigSchema — active/inactive refinement", () => {
  it("accepts 3 active panelists", () => {
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x" },
        { id: "c", label: "C", tool: "pi"     as const, systemPrompt: "x" },
      ],
      ...validBase,
    };
    expect(() => CouncilConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts 2 active + 1 inactive", () => {
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x" },
        { id: "c", label: "C", tool: "pi"     as const, systemPrompt: "x", active: false },
      ],
      ...validBase,
    };
    expect(() => CouncilConfigSchema.parse(config)).not.toThrow();
  });

  it("rejects 1 active + 2 inactive", () => {
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x", active: false },
        { id: "c", label: "C", tool: "pi"     as const, systemPrompt: "x", active: false },
      ],
      ...validBase,
    };
    expect(() => CouncilConfigSchema.parse(config)).toThrow(/at least 2/i);
  });

  it("rejects 0 active", () => {
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x", active: false },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x", active: false },
      ],
      ...validBase,
    };
    expect(() => CouncilConfigSchema.parse(config)).toThrow(/at least 2/i);
  });

  it("treats `active: undefined` as active (backward compat)", () => {
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x" },
      ],
      ...validBase,
    };
    expect(() => CouncilConfigSchema.parse(config)).not.toThrow();
  });
});

describe("saveConfig round-trip with active", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-active-"));
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x" },
        { id: "c", label: "C", tool: "pi"     as const, systemPrompt: "x" },
      ],
      ...validBase,
    };
    await fs.writeFile(path.join(dir, "panelists.json"), JSON.stringify(config, null, 2));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  // saveConfig is the server-side writer. It round-trips the schema exactly.
  // The "omit when true" rule lives in the client's denormalizeConfig.
  it("preserves `active: false` on disk after a save", async () => {
    const configPath = path.join(dir, "panelists.json");
    const original = JSON.parse(await fs.readFile(configPath, "utf-8"));
    original.panelists[2].active = false;   // 2 active + 1 inactive — valid
    saveConfig(original, configPath);
    const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(saved.panelists[2].active).toBe(false);
  });
});

describe("loadConfig exposes active flag", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-loadactive-"));
    const config = {
      panelists: [
        { id: "a", label: "A", tool: "claude" as const, systemPrompt: "x" },
        { id: "b", label: "B", tool: "pi"     as const, systemPrompt: "x", active: false },
        { id: "c", label: "C", tool: "pi"     as const, systemPrompt: "x" },
      ],
      ...validBase,
    };
    await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
    await fs.writeFile(path.join(dir, "panelists.json"), JSON.stringify(config, null, 2));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("propagates active to the runtime PanelistConfig", () => {
    const c = loadConfig("/tmp/wt", "r1", path.join(dir, "panelists.json"));
    expect(c.panelists.find((p) => p.id === "a")?.active).toBeUndefined();
    expect(c.panelists.find((p) => p.id === "b")?.active).toBe(false);
    expect(c.panelists.find((p) => p.id === "c")?.active).toBeUndefined();
  });
});

describe("POST /api/config rejects < 2 active", () => {
  let original = "";
  let cleanup = false;
  beforeEach(() => {
    original = require("fs").readFileSync(resolveConfigPath(), "utf-8");
  });
  afterEach(() => {
    if (cleanup) require("fs").writeFileSync(resolveConfigPath(), original, "utf-8");
    cleanup = false;
  });

  it("rejects a save with only 1 active panelist", async () => {
    cleanup = true;
    const { handlePostConfig } = await import("../src/server/config-api.ts");
    const req = new Request("http://x/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        panelists: [
          { id: "a", label: "A", tool: "claude", systemPrompt: "x" },
          { id: "b", label: "B", tool: "pi", systemPrompt: "x", active: false },
          { id: "c", label: "C", tool: "pi", systemPrompt: "x", active: false },
        ],
        ...validBase,
      }),
    });
    const res = await handlePostConfig(req);
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toMatch(/at least 2/i);
  });
});
