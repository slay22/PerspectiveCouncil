import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { inferMode, bootstrapGreenfield, createWorktrees, removeWorktrees } from "../src/core/worktree.ts";
import { loadSpec } from "../src/core/spec.ts";
import { loadConfig } from "../config/panelists.ts";

describe("loadSpec", () => {
  let dir = "";
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-spec-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("uses the context alone when no spec file is given", async () => {
    const out = await loadSpec(undefined, "Build a CLI that reverses stdin");
    expect(out).toContain("Build a CLI that reverses stdin");
    expect(out).not.toContain("# Specification");
  });

  it("includes the spec file contents when given", async () => {
    const p = path.join(dir, "spec.md");
    await fs.writeFile(p, "## Requirements\n- read stdin\n- print reversed");
    const out = await loadSpec(p, "Reverse CLI");
    expect(out).toContain("Reverse CLI");
    expect(out).toContain("read stdin");
  });
});

describe("inferMode + bootstrapGreenfield", () => {
  let dir = "";
  let base = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-gf-"));
    base = await fs.mkdtemp(path.join(os.tmpdir(), "council-gfwt-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  it("infers greenfield for an empty dir and maintenance after bootstrap", async () => {
    expect(await inferMode(dir)).toBe("greenfield");
    await bootstrapGreenfield(dir, "main");
    expect(await inferMode(dir)).toBe("maintenance");
  });

  it("is idempotent and leaves a usable base for worktrees", async () => {
    await bootstrapGreenfield(dir, "main");
    await bootstrapGreenfield(dir, "main"); // second call must not throw
    const panelists = [{ worktreePath: path.join(base, "council-gf-security") }];
    await createWorktrees(dir, "main", panelists);
    let exists = true;
    try { await fs.access(panelists[0]!.worktreePath); } catch { exists = false; }
    expect(exists).toBe(true);
    await removeWorktrees(dir, panelists);
  });
});

describe("loadConfig greenfield prompt selection", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-gfcfg-"));
    await fs.mkdir(path.join(dir, "prompts", "greenfield"), { recursive: true });
    await fs.writeFile(path.join(dir, "prompts", "security.md"), "MAINTENANCE PROMPT");
    await fs.writeFile(path.join(dir, "prompts", "greenfield", "security.md"), "GREENFIELD PROMPT");
    const config = {
      panelists: [
        { id: "security", label: "Security", tool: "claude", promptFile: "./prompts/security.md" },
        { id: "quality",  label: "Quality",  tool: "pi",     systemPrompt: "q" },
      ],
      judge: { tool: "pi", label: "Judge", systemPrompt: "j" },
      validator: { tool: "claude", label: "Validator", systemPrompt: "v" },
    };
    await fs.writeFile(path.join(dir, "panelists.json"), JSON.stringify(config));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("uses the greenfield variant in greenfield mode", () => {
    const c = loadConfig("/tmp/wt", "r1", path.join(dir, "panelists.json"), "greenfield");
    expect(c.panelists[0]?.systemPrompt).toBe("GREENFIELD PROMPT");
  });

  it("uses the original prompt in maintenance mode", () => {
    const c = loadConfig("/tmp/wt", "r1", path.join(dir, "panelists.json"), "maintenance");
    expect(c.panelists[0]?.systemPrompt).toBe("MAINTENANCE PROMPT");
  });
});
