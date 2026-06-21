import { store } from "./store.ts";
import type { HILDecision } from "../core/types.ts";
import type { PipelineEvent } from "./store.ts";
import type { ConductorConfig } from "../main.ts";
import type { JudgePlan, ValidatorReport } from "../core/types.ts";

// ─── Typed Event Payloads ─────────────────────────────────────────────────────

type EventPayloads = {
  stage_changed:    { stage: string };
  judge_done:       { plan: JudgePlan };
  validator_done:   { report: ValidatorReport };
  pr_created:       { url: string };
  pipeline_error:   { error: unknown };
};

function getPayload<K extends keyof EventPayloads>(
  event: PipelineEvent,
  type: K
): EventPayloads[K] | undefined {
  if (event.type !== type) return undefined;
  return event.payload as EventPayloads[K] | undefined;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name: string };
  chat: { id: number };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name: string };
  message?: TgMessage;
  data?: string;
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

// ─── State ────────────────────────────────────────────────────────────────────

let BOT_TOKEN = "";
let ALLOWED_CHAT_IDS: Set<number> = new Set();
let pipelineRunner: ((config: ConductorConfig) => Promise<void>) | null = null;
let offset = 0;
let polling = false;

const subscribedChats  = new Set<number>();
const awaitingNotes    = new Map<number, { decision: HILDecision; reviewer: string }>();

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initTelegramBot(opts: {
  token: string;
  allowedChatIds: number[];
  onRun: (config: ConductorConfig) => Promise<void>;
}): Promise<void> {
  BOT_TOKEN          = opts.token;
  ALLOWED_CHAT_IDS   = new Set(opts.allowedChatIds);
  pipelineRunner     = opts.onRun;

  // Remove any stale webhook so polling works cleanly
  await tgCall("deleteWebhook", {});

  // Verify token
  const me = await tgCall("getMe", {});
  if (!me?.result?.username) throw new Error("Telegram token invalid — getMe failed");

  console.log(`  🤖 Telegram bot @${me.result.username} ready (polling)`);

  // Subscribe to store events → push notifications
  store.subscribe(handleStoreEvent);

  // Start polling loop
  startPolling();
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

function startPolling(): void {
  if (polling) return;
  polling = true;

  const poll = async () => {
    if (!polling) return;
    try {
      const res = await tgCall("getUpdates", {
        offset,
        timeout: 30,          // long-poll: blocks up to 30s server-side
        allowed_updates: ["message", "callback_query"],
      });
      if (res?.result?.length) {
        for (const update of res.result as TgUpdate[]) {
          offset = update.update_id + 1;
          handleUpdate(update).catch((e) =>
            console.error("[Telegram] handler error:", e)
          );
        }
      }
    } catch (e) {
      // Network blip — wait a second then retry
      await sleep(1000);
    }
    // Always pace polling so we don't hammer Telegram on success.
    await sleep(1000);
    poll(); // tail-recurse
  };

  poll();
}

export function stopPolling(): void {
  polling = false;
}

// ─── Update Router ────────────────────────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
  } else if (update.message?.text) {
    await handleMessage(update.message);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(msg: TgMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim() ?? "";

  if (ALLOWED_CHAT_IDS.size > 0 && !ALLOWED_CHAT_IDS.has(chatId)) {
    await send(chatId, "⛔ Unauthorized.");
    return;
  }

  // ── Intercept notes awaiting free-text ────────────────────────────────────
  const pending = awaitingNotes.get(chatId);
  if (pending && !text.startsWith("/")) {
    awaitingNotes.delete(chatId);
    submitHIL(chatId, pending.decision, pending.reviewer, text);
    return;
  }

  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd?.toLowerCase()) {

    case "/start":
    case "/help":
      subscribedChats.add(chatId);
      await send(chatId, formatHelp());
      break;

    case "/run": {
      // /run <repo> <branch> <context...>
      if (args.length < 3) {
        await send(chatId, "Usage: `/run <repo> <branch> <context>`\n\nExample:\n`/run /projects/api main Harden for production`");
        break;
      }
      const active = store.getState();
      if (active && active.currentStage !== "done" && active.currentStage !== "aborted") {
        await send(chatId, "⏳ A run is already in progress. Use `/status` to check.");
        break;
      }
      const repoPath = args[0];
      const branch   = args[1];
      const contextParts = args.slice(2);
      const projectContext = contextParts.join(" ");
      if (!repoPath || !branch) break;
      subscribedChats.add(chatId);
      await send(chatId,
        `🚀 *Starting Perspective Council*\n\n` +
        `📁 \`${repoPath}\`\n🌿 \`${branch}\`\n📝 ${projectContext}`
      );
      pipelineRunner?.({ repoPath, branch, projectContext }).catch(async (e) => {
        await send(chatId, `❌ Pipeline error: ${String(e).slice(0, 300)}`);
      });
      break;
    }

    case "/status": {
      const state = store.getState();
      if (!state) { await send(chatId, "No pipeline running."); break; }
      await send(chatId, formatStatus(state));
      break;
    }

    case "/hil": {
      const state = store.getState();
      if (!state?.hilPending) {
        await send(chatId, "No HIL review pending right now. Use `/status` to check.");
        break;
      }
      const sub  = args[0]?.toLowerCase();
      const rest = args.slice(1).join(" ").replace(/^["']|["']$/g, "");

      if (!sub) {
        await sendHILKeyboard(chatId);
        break;
      }
      if (sub === "approve")        submitHIL(chatId, "approve", senderName(msg), rest || undefined);
      else if (sub === "abort")     submitHIL(chatId, "abort",   senderName(msg));
      else if (sub === "revise_plan")
        rest ? submitHIL(chatId, "revise_plan", senderName(msg), undefined, rest)
             : promptNotes(chatId, "revise_plan", senderName(msg), "Send instructions for the judge:");
      else if (sub === "revise_impl")
        rest ? submitHIL(chatId, "revise_implementation", senderName(msg), undefined, undefined, rest)
             : promptNotes(chatId, "revise_implementation", senderName(msg), "Send instructions for Claude Code:");
      else await sendHILKeyboard(chatId);
      break;
    }

    case "/abort": {
      const state = store.getState();
      if (!state?.hilPending) { await send(chatId, "No HIL pending."); break; }
      submitHIL(chatId, "abort", senderName(msg));
      break;
    }

    default:
      if (text.startsWith("/")) await send(chatId, "Unknown command. Send /help");
  }
}

// ─── Inline Keyboard Callback ─────────────────────────────────────────────────

async function handleCallback(cb: TgCallbackQuery): Promise<void> {
  const chatId   = cb.message?.chat.id ?? cb.from.id;
  const msgId    = cb.message?.message_id;
  const data     = cb.data ?? "";
  const reviewer = senderName(undefined, cb);

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id });

  if (!data.startsWith("hil:")) return;
  const decision = data.slice(4);

  const needsText: Record<string, string> = {
    approve_notes_ask:  "Send your notes for the PR description:",
    revise_plan_ask:    "Send your instructions for the judge:",
    revise_impl_ask:    "Send your instructions for Claude Code:",
  };

  if (needsText[decision]) {
    if (msgId) await editMessage(chatId, msgId, `✎ ${needsText[decision]}`);
    const hilDecision: HILDecision = decision === "approve_notes_ask"
      ? "approve_with_notes"
      : decision === "revise_plan_ask"
      ? "revise_plan"
      : "revise_implementation";
    awaitingNotes.set(chatId, { decision: hilDecision, reviewer });
    return;
  }

  const decisionMap: Record<string, HILDecision> = {
    approve: "approve",
    abort:   "abort",
  };

  if (decisionMap[decision]) {
    submitHIL(chatId, decisionMap[decision], reviewer, undefined, undefined, undefined, msgId);
  }
}

// ─── HIL Submission ───────────────────────────────────────────────────────────

function submitHIL(
  chatId: number,
  decision: HILDecision,
  reviewer: string,
  notes?: string,
  revisePlanInstructions?: string,
  reviseImplInstructions?: string,
  editMsgId?: number,
): void {
  store.setHILResponse({ decision, reviewer, notes, revisePlanInstructions, reviseImplInstructions });

  const label: Record<HILDecision, string> = {
    approve:                "✅ Approved",
    approve_with_notes:     "✅ Approved with notes",
    revise_plan:            "⟳ Plan revision requested",
    revise_implementation:  "⟳ Implementation revision requested",
    abort:                  "🛑 Aborted",
  };

  const text = `${label[decision]} by ${reviewer}`;
  if (editMsgId) {
    editMessage(chatId, editMsgId, text).catch(() => {});
  } else {
    send(chatId, text).catch(() => {});
  }
}

async function promptNotes(chatId: number, decision: HILDecision, reviewer: string, prompt: string): Promise<void> {
  awaitingNotes.set(chatId, { decision, reviewer });
  await send(chatId, prompt);
}

// ─── Store → Telegram Notifications ──────────────────────────────────────────

async function handleStoreEvent(event: PipelineEvent): Promise<void> {
  if (subscribedChats.size === 0) return;

  let msg: string | null = null;

  switch (event.type) {
    case "stage_changed": {
      const labels: Record<string, string> = {
        worktrees:  "🌲 Setting up worktrees…",
        panel:      "🔭 Panel analysis started…",
        judge:      "⚖️ Judge synthesizing plan…",
        implement:  "⚙️ Claude Code implementing…",
        validate:   "✅ Validator checking…",
        pr:         "🚀 Creating pull request…",
      };
      const stage = getPayload(event, "stage_changed")?.stage;
      msg = stage ? labels[stage] ?? null : null;
      break;
    }
    case "panel_complete": {
      const state = store.getState();
      if (!state) break;
      const lines = state.panelists.map((p) =>
        `${p.icon} *${p.label}*: \`${(p.result?.riskLevel ?? "?").toUpperCase()}\``
      );
      msg = `🔭 *Panel complete*\n\n${lines.join("\n")}`;
      break;
    }
    case "judge_done": {
      const plan = getPayload(event, "judge_done")?.plan;
      if (!plan) break;
      const p0 = plan.tasks.filter((t) => t.priority === "P0").length;
      msg = `⚖️ *Plan ready* — ${plan.tasks.length} tasks (${p0} P0)\n_${plan.summary.slice(0, 150)}_`;
      break;
    }
    case "validator_done": {
      const report = getPayload(event, "validator_done")?.report;
      if (!report) break;
      const e = { PASS: "✅", PARTIAL: "⚠️", REJECT: "❌" }[report.verdict] ?? "?";
      msg = `${e} *Validator: ${report.verdict}*\n${report.notes.slice(0, 200)}`;
      break;
    }
    case "hil_pending": {
      for (const chatId of subscribedChats) {
        const summary = formatHILSummary(store.getState());
        await sendHILKeyboard(chatId, summary).catch(() => {});
      }
      return;
    }
    case "pr_created":
      msg = `🎉 *PR Created*\n${getPayload(event, "pr_created")?.url ?? ""}`;
      break;
    case "pipeline_done":
      msg = "🎉 *Pipeline complete!*";
      break;
    case "pipeline_error":
      msg = `❌ *Error*\n\`${String(getPayload(event, "pipeline_error")?.error).slice(0, 200)}\``;
      break;
  }

  if (msg) {
    for (const chatId of subscribedChats) {
      await send(chatId, msg).catch(() => {});
    }
  }
}

// ─── HIL Keyboard ─────────────────────────────────────────────────────────────

async function sendHILKeyboard(chatId: number, prefixText?: string): Promise<void> {
  const text = prefixText ?? formatHILSummary(store.getState());
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve",         callback_data: "hil:approve" },
        { text: "✎ Approve + notes",  callback_data: "hil:approve_notes_ask" },
      ],
      [
        { text: "⟳ Revise plan",     callback_data: "hil:revise_plan_ask" },
        { text: "⟳ Revise impl",     callback_data: "hil:revise_impl_ask" },
      ],
      [
        { text: "🛑 Abort",          callback_data: "hil:abort" },
      ],
    ],
  };
  await tgCall("sendMessage", {
    chat_id: chatId, text, parse_mode: "Markdown", reply_markup: keyboard,
  });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatHelp(): string {
  return `⚖️ *Perspective Council*

*Start a run:*
\`/run <repo> <branch> <context>\`

*During a run:*
\`/status\` — current stage
\`/hil\` — show review keyboard (when pending)
\`/hil approve\` — approve as-is
\`/hil abort\` — abort pipeline
\`/hil revise_plan <instructions>\`
\`/hil revise_impl <instructions>\`

When HIL is ready you'll get a keyboard automatically.`;
}

function formatStatus(state: ReturnType<typeof store.getState>): string {
  if (!state) return "No pipeline running.";
  const done  = state.tasks.filter((t) => t.status === "done").length;
  const total = state.tasks.length;
  const tasks = total > 0 ? `\n📋 Tasks: ${done}/${total}` : "";
  const iter  = state.iteration > 0 ? ` (iter ${state.iteration}/${state.maxIterations})` : "";
  return `📊 *Status*\n\nStage: \`${state.currentStage}\`${iter}${tasks}`;
}

function formatHILSummary(state: ReturnType<typeof store.getState>): string {
  if (!state) return "👤 *HIL Review*";
  const lines = state.panelists.map((p) =>
    `${p.icon} *${p.label}* \`[${(p.result?.riskLevel ?? "?").toUpperCase()}]\``
  ).join("\n");
  const p0 = state.tasks.filter((t) => t.priority === "P0").length;
  const verdict = state.validatorReport?.verdict ?? "—";
  return `👤 *Human Review Required*\n\n${lines}\n\n` +
    `📐 ${state.tasks.length} tasks (${p0} P0) · ` +
    `✅ Validator: \`${verdict}\`\n\n` +
    `_Choose below or open the GUI for full diff._`;
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function send(chatId: number, text: string): Promise<void> {
  await tgCall("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

async function editMessage(chatId: number, messageId: number, text: string): Promise<void> {
  await tgCall("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" });
}

interface TgApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

async function tgCall(method: string, body: Record<string, unknown>): Promise<any> {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    const data = await res.json() as TgApiResponse;
    if (!data.ok) {
      console.error(`[Telegram] ${method} returned not-ok: ${data.error_code} ${data.description ?? ""}`);
      return null;
    }
    // Preserve the existing shape callers expect ({ result }).
    return data;
  } catch (e) {
    console.error(`[Telegram] ${method} failed:`, e);
    return null;
  }
}

function senderName(msg?: TgMessage, cb?: TgCallbackQuery): string {
  const from = msg?.from ?? cb?.from;
  if (!from) return "unknown";
  return from.username ? `@${from.username}` : from.first_name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
