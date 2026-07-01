import { describe, it, expect } from "bun:test";
import { store } from "../src/server/store.ts";

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

describe("store.abortCurrentRun", () => {
  it("is a no-op when idle (returns false, no state change)", () => {
    initRun("abort-1");
    store.setDone();
    expect(store.abortCurrentRun()).toBe(false);
    expect(store.getState()?.currentStage).toBe("done");
  });

  it("aborts an active run: sets aborted, fires the signal", () => {
    initRun("abort-2");
    store.setStage("implement");
    const sig = store.abortSignal();
    expect(sig?.aborted).toBe(false);
    expect(store.abortCurrentRun()).toBe(true);
    expect(store.getState()?.currentStage).toBe("aborted");
    expect(sig?.aborted).toBe(true);
    expect(store.isIdle()).toBe(true);
  });

  it("releases a pending HIL gate with an abort decision so runPipeline can unwind", async () => {
    initRun("abort-3");
    store.setStage("hil");
    store.setHILPending();
    const hilPromise = store.waitForHIL();
    store.abortCurrentRun();
    const res = await hilPromise;
    expect(res.decision).toBe("abort");
    expect(store.getState()?.currentStage).toBe("aborted");
  });

  it("abortSignal() returns a fresh signal per run (init resets the controller)", () => {
    initRun("abort-4a");
    const sig1 = store.abortSignal();
    store.abortCurrentRun();
    expect(sig1?.aborted).toBe(true);
    initRun("abort-4b");
    const sig2 = store.abortSignal();
    expect(sig2?.aborted).toBe(false);
  });
});