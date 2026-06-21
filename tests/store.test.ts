import { describe, it, expect } from "bun:test";
import { store } from "../src/server/store.ts";
import type { PipelineEvent } from "../src/server/store.ts";

function initStore() {
  store.init({
    runId: "test-run",
    repoPath: "/tmp/repo",
    branch: "main",
    projectContext: "ctx",
    maxIterations: 3,
    panelists: [
      { id: "security", label: "Security", icon: "🔐", model: "claude" },
      { id: "quality", label: "Quality", icon: "📊", model: "opencode" },
    ],
  });
}

describe("StateStore", () => {
  it("initializes with pending panelists and no tasks", () => {
    initStore();
    const s = store.getState()!;
    expect(s.runId).toBe("test-run");
    expect(s.panelists).toHaveLength(2);
    expect(s.panelists.every((p) => p.status === "pending")).toBe(true);
    expect(s.tasks).toHaveLength(0);
    expect(s.currentStage).toBe("init");
  });

  it("tracks stage history with start/done timestamps", () => {
    initStore();
    store.setStage("panel");
    store.setStage("judge");
    const s = store.getState()!;
    expect(s.currentStage).toBe("judge");
    // The first stage should be closed out when the next one starts.
    expect(s.stageHistory[0]?.stage).toBe("panel");
    expect(s.stageHistory[0]?.doneAt).toBeDefined();
    expect(s.stageHistory[1]?.doneAt).toBeUndefined();
  });

  it("transitions panelist status through started → done", () => {
    initStore();
    store.panelistStarted("security");
    expect(store.getState()!.panelists.find((p) => p.id === "security")!.status).toBe("running");

    store.panelistDone("security", {
      panelistId: "security",
      label: "Security",
      analysis: "ok",
      keyFindings: ["a"],
      riskLevel: "high",
    });
    const p = store.getState()!.panelists.find((q) => q.id === "security")!;
    expect(p.status).toBe("done");
    expect(p.result?.riskLevel).toBe("high");
  });

  it("derives tasks from the judge plan", () => {
    initStore();
    store.setJudgePlan({
      summary: "do things",
      tasks: [
        { id: "t1", file: "a.ts", action: "modify", instruction: "x", rationale: "y", priority: "P0", source: ["security"] },
      ],
      riskFlags: [],
      outOfScope: [],
    });
    const s = store.getState()!;
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]?.status).toBe("pending");

    store.taskStarted("t1");
    expect(store.getState()!.tasks[0]?.status).toBe("running");
    store.taskDone("t1");
    expect(store.getState()!.tasks[0]?.status).toBe("done");
  });

  it("resolves waitForHIL when a response arrives", async () => {
    initStore();
    store.setHILPending();
    expect(store.getState()!.hilPending).toBe(true);

    const pending = store.waitForHIL();
    store.setHILResponse({ decision: "approve", reviewer: "alice" });

    const response = await pending;
    expect(response.decision).toBe("approve");
    expect(store.getState()!.hilPending).toBe(false);
  });

  it("notifies subscribers and supports unsubscribe", () => {
    initStore();
    const seen: PipelineEvent[] = [];
    const unsub = store.subscribe((e) => seen.push(e));
    store.log("info", "hello");
    expect(seen.some((e) => e.type === "log")).toBe(true);

    unsub();
    const countBefore = seen.length;
    store.log("info", "after unsubscribe");
    expect(seen.length).toBe(countBefore);
  });

  it("isolates a subscriber error from the store", () => {
    initStore();
    store.subscribe(() => { throw new Error("boom"); });
    // Should not throw despite the faulty subscriber.
    expect(() => store.log("info", "still works")).not.toThrow();
  });
});
