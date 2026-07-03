import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleMessage, handleCallback, setTgCallForTest, resetTelegramForTest,
} from "../src/server/telegram.ts";
import { store } from "../src/server/store.ts";

// ─── Telegram handler unit tests ────────────────────────────────────────────
// Handlers are invoked directly with synthetic updates; tgCall is stubbed to a
// spy that records outgoing sendMessage/editMessageText/answerCallbackQuery
// calls and returns a benign not-ok sentinel for everything else (so handlers
// read `result` as null and short-circuit harmlessly). No network, no polling.

const ALLOWED = 111;
let calls: { method: string; body: Record<string, unknown> }[] = [];

function msg(text: string, chatId = ALLOWED, fromUsername = "alice") {
  return {
    message_id: 1,
    from: { id: 1, username: fromUsername, first_name: "Alice" },
    chat: { id: chatId },
    text,
  };
}

function callback(data: string, chatId = ALLOWED, fromUsername = "alice") {
  return {
    id: "cb1",
    from: { id: 1, username: fromUsername, first_name: "Alice" },
    message: { message_id: 9, chat: { id: chatId }, text: "x" },
    data,
  };
}

beforeEach(() => {
  calls = [];
  setTgCallForTest(async (method, body) => {
    calls.push({ method, body });
    if (method === "getMe") return { ok: true, result: { username: "testbot" } };
    return { ok: false }; // sendMessage etc. → handlers read result?.foo → null
  });
  resetTelegramForTest({ allowedChatIds: [ALLOWED] });
  // Initialize the store so HIL ops don't throw; abort an active run from any
  // previous case so each test starts idle.
  store.init({
    runId: "tg-test", repoPath: "/tmp/x", branch: "main", projectContext: "ctx",
    maxIterations: 3,
    panelists: [{ id: "a", label: "A", icon: "🤖", model: "claude" }],
  });
});

afterEach(() => {
  setTgCallForTest(null);
  store.abortCurrentRun();
});

describe("Telegram handleMessage", () => {
  it("refuses a disallowed chat", async () => {
    await handleMessage(msg("/status", 999));
    expect(calls.some((c) => c.method === "sendMessage" && (c.body.text as string).includes("Unauthorized"))).toBe(true);
  });

  it("/status reports the stage", async () => {
    await handleMessage(msg("/status"));
    expect(calls.some((c) => c.method === "sendMessage" && (c.body.text as string).includes("Status"))).toBe(true);
  });

  it("/cancel when idle is a no-op ('Nothing to cancel')", async () => {
    store.setDone();
    await handleMessage(msg("/cancel"));
    expect(calls.some((c) => c.method === "sendMessage" && (c.body.text as string).includes("Nothing to cancel"))).toBe(true);
  });

  it("/cancel when active aborts the run", async () => {
    store.init({ runId: "tg-2", repoPath: "/tmp/x", branch: "main", projectContext: "c", maxIterations: 3, panelists: [{ id: "a", label: "A", icon: "🤖", model: "claude" }] });
    store.setStage("implement");
    await handleMessage(msg("/cancel"));
    expect(store.getState()?.currentStage).toBe("aborted");
    expect(calls.some((c) => c.method === "sendMessage" && (c.body.text as string).includes("cancelled"))).toBe(true);
  });
});

describe("Telegram HIL notes flow (guards)", () => {
  it("a stray free-text message with NO pending HIL is dropped (not resolved)", async () => {
    store.setDone();
    // Put a stale awaitingNotes entry by simulating a callback that asks for notes.
    await handleCallback(callback("hil:approve_notes_ask"));
    // Now send free text — but no HIL is pending → must NOT call setHILResponse.
    const before = store.getState()?.hilResponse;
    await handleMessage(msg("here are my notes"));
    expect(store.getState()?.hilResponse).toEqual(before);
    expect(store.getState()?.hilPending).toBe(false);
  });

  it("handleCallback from a disallowed chat is ignored", async () => {
    const before = store.getState()?.hilPending;
    await handleCallback(callback("hil:approve", 999));
    expect(store.getState()?.hilPending).toBe(before);
  });
});