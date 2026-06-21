import { describe, it, expect } from "bun:test";
import {
  JudgePlanSchema,
  ValidatorReportSchema,
  CouncilConfigSchema,
  HILResponseSchema,
  RunRequestSchema,
} from "../src/core/schemas.ts";

describe("JudgePlanSchema", () => {
  it("accepts a valid plan", () => {
    const plan = {
      summary: "Fix auth and add tests.",
      tasks: [
        {
          id: "task-001",
          file: "src/auth.ts",
          action: "modify",
          instruction: "Replace static secret",
          rationale: "Security flagged it",
          priority: "P0",
          source: ["security"],
        },
      ],
      riskFlags: ["Static secret"],
      outOfScope: [],
    };
    expect(() => JudgePlanSchema.parse(plan)).not.toThrow();
  });

  it("rejects an invalid action", () => {
    const plan = {
      summary: "Fix auth.",
      tasks: [
        {
          id: "task-001",
          file: "src/auth.ts",
          action: "patch", // invalid
          instruction: "Replace static secret",
          rationale: "Security flagged it",
          priority: "P0",
          source: ["security"],
        },
      ],
      riskFlags: [],
      outOfScope: [],
    };
    expect(() => JudgePlanSchema.parse(plan)).toThrow();
  });

  it("accepts the synthetic \"hil\" source for human revisions", () => {
    const plan = {
      summary: "Apply reviewer-requested change.",
      tasks: [
        {
          id: "hil-1",
          file: ".",
          action: "refactor",
          instruction: "Rename the helper",
          rationale: "Human reviewer requested",
          priority: "P0",
          source: ["hil"],
        },
      ],
      riskFlags: [],
      outOfScope: [],
    };
    expect(() => JudgePlanSchema.parse(plan)).not.toThrow();
  });

  it("rejects an invalid panelist source", () => {
    const plan = {
      summary: "Fix auth.",
      tasks: [
        {
          id: "task-001",
          file: "src/auth.ts",
          action: "modify",
          instruction: "Replace static secret",
          rationale: "Security flagged it",
          priority: "P0",
          source: ["unknown"],
        },
      ],
      riskFlags: [],
      outOfScope: [],
    };
    expect(() => JudgePlanSchema.parse(plan)).toThrow();
  });
});

describe("ValidatorReportSchema", () => {
  it("accepts a valid report", () => {
    const report = {
      verdict: "PASS",
      taskResults: [{ taskId: "task-001", verdict: "PASS", notes: "Done" }],
      outOfScopeChanges: [],
      notes: "All good",
    };
    expect(() => ValidatorReportSchema.parse(report)).not.toThrow();
  });

  it("rejects an invalid verdict", () => {
    const report = {
      verdict: "OK",
      taskResults: [],
      outOfScopeChanges: [],
      notes: "",
    };
    expect(() => ValidatorReportSchema.parse(report)).toThrow();
  });
});

describe("CouncilConfigSchema", () => {
  it("accepts config with promptFile", () => {
    const config = {
      panelists: [
        {
          id: "security",
          label: "Security",
          tool: "claude",
          promptFile: "./prompts/security.md",
        },
      ],
      judge: {
        tool: "pi",
        label: "Judge",
        promptFile: "./prompts/judge.md",
      },
      validator: {
        tool: "claude",
        label: "Validator",
        promptFile: "./prompts/validator.md",
      },
    };
    expect(() => CouncilConfigSchema.parse(config)).not.toThrow();
  });

  it("requires systemPrompt or promptFile", () => {
    const config = {
      panelists: [
        {
          id: "security",
          label: "Security",
          tool: "claude",
        },
      ],
      judge: {
        tool: "pi",
        label: "Judge",
        systemPrompt: "foo",
      },
      validator: {
        tool: "claude",
        label: "Validator",
        systemPrompt: "bar",
      },
    };
    expect(() => CouncilConfigSchema.parse(config)).toThrow();
  });
});

describe("HILResponseSchema", () => {
  it("accepts a valid response", () => {
    const response = {
      decision: "approve",
      reviewer: "alice",
      notes: "Looks good",
    };
    expect(() => HILResponseSchema.parse(response)).not.toThrow();
  });

  it("requires reviewer", () => {
    const response = {
      decision: "approve",
    };
    expect(() => HILResponseSchema.parse(response)).toThrow();
  });
});

describe("RunRequestSchema", () => {
  it("accepts a maintenance request", () => {
    expect(() => RunRequestSchema.parse({ repoPath: "/r", projectContext: "fix it" })).not.toThrow();
  });
  it("accepts a greenfield request with mode and spec", () => {
    expect(() => RunRequestSchema.parse({
      repoPath: "/new", projectContext: "build it", mode: "greenfield", specPath: "./SPEC.md",
    })).not.toThrow();
  });
  it("rejects a missing context and an invalid mode", () => {
    expect(() => RunRequestSchema.parse({ repoPath: "/r" })).toThrow();
    expect(() => RunRequestSchema.parse({ repoPath: "/r", projectContext: "x", mode: "build" })).toThrow();
  });
});
