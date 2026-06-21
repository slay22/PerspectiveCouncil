import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { runEvaluation, formatEvalForValidator } from "../src/core/evaluate.ts";
import { EvaluationConfigSchema } from "../src/core/schemas.ts";

describe("runEvaluation", () => {
  let dir = "";
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-eval-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("does nothing when disabled", async () => {
    const r = await runEvaluation(dir, { enabled: false, test: "echo nope" });
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.steps).toHaveLength(0);
  });

  it("runs steps in order and passes when all succeed", async () => {
    const r = await runEvaluation(dir, { enabled: true, build: "true", test: "true" });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["build", "test"]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });

  it("stops and marks later steps skipped after a failure", async () => {
    const r = await runEvaluation(dir, { enabled: true, build: "false", test: "true" });
    expect(r.passed).toBe(false);
    const build = r.steps.find((s) => s.step === "build")!;
    const test = r.steps.find((s) => s.step === "test")!;
    expect(build.ok).toBe(false);
    expect(test.skipped).toBe(true);
  });

  it("captures command output", async () => {
    const r = await runEvaluation(dir, { enabled: true, test: "echo hello-from-test" });
    expect(r.steps[0]?.output).toContain("hello-from-test");
  });
});

describe("formatEvalForValidator", () => {
  it("returns empty string when nothing ran", () => {
    expect(formatEvalForValidator({ ran: false, passed: true, steps: [] })).toBe("");
  });

  it("summarizes pass/fail with failing command output", () => {
    const out = formatEvalForValidator({
      ran: true,
      passed: false,
      steps: [
        { step: "build", command: "bun run build", ok: true, exitCode: 0, output: "" },
        { step: "test", command: "bun test", ok: false, exitCode: 1, output: "expected 1 got 2" },
      ],
    });
    expect(out).toContain("FAILED");
    expect(out).toContain("test: FAILED");
    expect(out).toContain("expected 1 got 2");
  });
});

describe("EvaluationConfig schema", () => {
  it("accepts an empty object and a full config", () => {
    expect(() => EvaluationConfigSchema.parse({})).not.toThrow();
    expect(() => EvaluationConfigSchema.parse({ enabled: true, test: "bun test", timeoutMs: 1000 })).not.toThrow();
  });
  it("rejects a non-positive timeout", () => {
    expect(() => EvaluationConfigSchema.parse({ timeoutMs: 0 })).toThrow();
  });
});
