import { describe, it, expect } from "bun:test";
import { store } from "../src/server/store.ts";

// Exercises the single "is a run active?" definition. The conductor and the
// HTTP/Telegram launchers all gate on store.isIdle(); the old per-callsite
// `currentStage !== done/aborted` reimplementations have been removed so they
// can't drift. The store is a process-global singleton, so each case drives it
// via init() (which resets state) rather than relying on global ordering.

const PANELISTS = [
  { id: "a", label: "A", icon: "🤖", model: "claude" },
  { id: "b", label: "B", icon: "🤖", model: "pi" },
];

function initRun(id: string): void {
  store.init({
    runId: id, repoPath: "/tmp/x", branch: "main", projectContext: "ctx",
    maxIterations: 3, panelists: PANELISTS,
  });
}

describe("store.isIdle (single source of truth for re-entry)", () => {
  it("is not idle mid-run", () => {
    initRun("idle-1");
    store.setStage("panel");
    expect(store.isIdle()).toBe(false);
  });

  it("becomes idle when the run completes (done)", () => {
    initRun("idle-2");
    store.setStage("implement");
    expect(store.isIdle()).toBe(false);
    store.setDone();
    expect(store.isIdle()).toBe(true);
  });

  it("becomes idle when the run aborts (setError → aborted)", () => {
    initRun("idle-3");
    store.setStage("panel");
    expect(store.isIdle()).toBe(false);
    store.setError("boom"); // setError sets currentStage = "aborted"
    expect(store.isIdle()).toBe(true);
  });

  it("a done run allows init() of a new run (re-entry)", () => {
    initRun("idle-4a");
    store.setDone();
    expect(store.isIdle()).toBe(true);
    // Starting a second run after done must succeed (no stale "active" gate).
    initRun("idle-4b");
    store.setStage("judge");
    expect(store.isIdle()).toBe(false);
  });
});