import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { saveConfig, CONFIG_PATH } from "../config/panelists.ts";
import { handleGetConfig, handlePostConfig } from "../src/server/config-api.ts";

describe("saveConfig", () => {
  let originalContent = "";
  let cleanup = false;

  beforeEach(() => {
    originalContent = fs.readFileSync(CONFIG_PATH, "utf-8");
  });

  afterEach(() => {
    if (cleanup) {
      fs.writeFileSync(CONFIG_PATH, originalContent, "utf-8");
      cleanup = false;
    }
  });

  it("writes a valid config to disk", () => {
    cleanup = true;
    const config = {
      panelists: [
        {
          id: "test",
          label: "Test Panelist",
          icon: "🧪",
          tool: "claude" as const,
          model: "claude-sonnet",
          systemPrompt: "You are a test panelist.",
        },
      ],
      judge: {
        tool: "pi" as const,
        label: "Judge",
        systemPrompt: "You are the judge.",
      },
      validator: {
        tool: "claude" as const,
        label: "Validator",
        promptFile: "./prompts/validator.md",
      },
    };

    saveConfig(config);

    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.panelists).toHaveLength(1);
    expect(saved.panelists[0].id).toBe("test");
    expect(saved.judge.label).toBe("Judge");
    expect(saved.validator.promptFile).toBe("./prompts/validator.md");
  });

  it("rejects invalid config", () => {
    cleanup = true;
    const invalid = {
      panelists: [],
      judge: { tool: "pi", label: "Judge", systemPrompt: "Judge" },
      validator: { tool: "claude", label: "Validator", systemPrompt: "Validator" },
    };
    expect(() => saveConfig(invalid)).toThrow();
  });
});

describe("config API handlers", () => {
  let originalContent = "";
  let cleanup = false;

  beforeEach(() => {
    originalContent = fs.readFileSync(CONFIG_PATH, "utf-8");
  });

  afterEach(() => {
    if (cleanup) {
      fs.writeFileSync(CONFIG_PATH, originalContent, "utf-8");
      cleanup = false;
    }
  });

  it("GET /api/config returns current config", async () => {
    const res = handleGetConfig();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.panelists).toBeArray();
    expect(body.judge).toBeObject();
    expect(body.validator).toBeObject();
  });

  it("POST /api/config saves valid config", async () => {
    cleanup = true;
    const next = {
      panelists: [
        {
          id: "api-test",
          label: "API Test",
          icon: "🧪",
          tool: "claude" as const,
          model: "",
          systemPrompt: "Test prompt",
        },
      ],
      judge: {
        tool: "pi" as const,
        label: "Judge",
        systemPrompt: "Judge prompt",
      },
      validator: {
        tool: "claude" as const,
        label: "Validator",
        systemPrompt: "Validator prompt",
      },
    };

    const req = new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });

    const res = await handlePostConfig(req);
    expect(res.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(saved.panelists[0].id).toBe("api-test");
  });

  it("POST /api/config rejects invalid config", async () => {
    cleanup = true;
    const req = new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ panelists: [] }),
    });

    const res = await handlePostConfig(req);
    expect(res.status).toBe(400);
  });
});
