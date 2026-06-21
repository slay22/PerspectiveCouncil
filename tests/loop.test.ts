import { describe, it, expect } from "bun:test";
import {
  planSignature,
  verdictImproved,
  isStalled,
  formatValidatorFeedback,
} from "../src/core/loop.ts";
import type { JudgePlan, ValidatorReport } from "../src/core/types.ts";

function plan(tasks: Array<{ id: string; file: string; action?: string }>): JudgePlan {
  return {
    summary: "s",
    tasks: tasks.map((t) => ({
      id: t.id,
      file: t.file,
      action: (t.action ?? "modify") as JudgePlan["tasks"][number]["action"],
      instruction: "do",
      rationale: "why",
      priority: "P0",
      source: ["security"],
    })),
    riskFlags: [],
    outOfScope: [],
  };
}

describe("planSignature", () => {
  it("is order-independent", () => {
    const a = plan([{ id: "1", file: "a.ts" }, { id: "2", file: "b.ts" }]);
    const b = plan([{ id: "2", file: "b.ts" }, { id: "1", file: "a.ts" }]);
    expect(planSignature(a)).toBe(planSignature(b));
  });

  it("changes when a task changes", () => {
    const a = plan([{ id: "1", file: "a.ts", action: "modify" }]);
    const b = plan([{ id: "1", file: "a.ts", action: "delete" }]);
    expect(planSignature(a)).not.toBe(planSignature(b));
  });
});

describe("verdictImproved", () => {
  it("treats first verdict as improvement", () => {
    expect(verdictImproved(undefined, "REJECT")).toBe(true);
  });
  it("REJECT → PARTIAL → PASS counts as improvement", () => {
    expect(verdictImproved("REJECT", "PARTIAL")).toBe(true);
    expect(verdictImproved("PARTIAL", "PASS")).toBe(true);
  });
  it("same or worse verdict is not improvement", () => {
    expect(verdictImproved("REJECT", "REJECT")).toBe(false);
    expect(verdictImproved("PARTIAL", "REJECT")).toBe(false);
  });
});

describe("isStalled", () => {
  it("is stalled when plan is identical and verdict did not improve", () => {
    expect(isStalled({ prevPlanSig: "x", currPlanSig: "x", prevVerdict: "REJECT", currVerdict: "REJECT" })).toBe(true);
  });
  it("is not stalled on the first iteration (no prev)", () => {
    expect(isStalled({ prevPlanSig: undefined, currPlanSig: "x", prevVerdict: undefined, currVerdict: "REJECT" })).toBe(false);
  });
  it("is not stalled when the plan changed", () => {
    expect(isStalled({ prevPlanSig: "x", currPlanSig: "y", prevVerdict: "REJECT", currVerdict: "REJECT" })).toBe(false);
  });
  it("is not stalled when the verdict improved", () => {
    expect(isStalled({ prevPlanSig: "x", currPlanSig: "x", prevVerdict: "REJECT", currVerdict: "PARTIAL" })).toBe(false);
  });
});

describe("formatValidatorFeedback", () => {
  it("includes verdict, notes, per-task results and out-of-scope", () => {
    const report: ValidatorReport = {
      verdict: "REJECT",
      taskResults: [{ taskId: "t1", verdict: "REJECT", notes: "missing null check" }],
      outOfScopeChanges: ["touched unrelated file"],
      notes: "incomplete",
    };
    const out = formatValidatorFeedback(report);
    expect(out).toContain("Overall verdict: REJECT");
    expect(out).toContain("incomplete");
    expect(out).toContain("t1: REJECT — missing null check");
    expect(out).toContain("touched unrelated file");
  });
});
