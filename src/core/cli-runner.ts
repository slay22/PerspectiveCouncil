import { $ } from "bun";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import type { CliTool } from "./schemas.ts";

type ShellPromise = ReturnType<typeof $>;

// ─── Types ────────────────────────────────────────────────────────────────────

export type { CliTool };

export interface CliRunOptions {
  tool:         CliTool;
  model?:       string | undefined;  // undefined = use tool's default
  systemPrompt: string | undefined;
  userMessage:  string;
  cwd?:         string;
  label?:       string;
  timeoutMs?:   number;              // optional timeout for the CLI call
}

// ─── Unified Runner ───────────────────────────────────────────────────────────

export async function runCLI(opts: CliRunOptions): Promise<string> {
  if (!opts.systemPrompt || opts.systemPrompt.trim() === "") {
    throw new Error(`[${opts.label ?? opts.tool}] systemPrompt is required`);
  }

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutFor(opts.tool);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await runCLIInner(opts, controller.signal);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`[${opts.label ?? opts.tool}] CLI call timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function runCLIInner(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  switch (opts.tool) {
    case "claude":   return runClaude(opts, signal);
    case "opencode": return runOpenCode(opts, signal);
    case "pi":       return runPi(opts, signal);
  }
}

function defaultTimeoutFor(tool: CliTool): number {
  // Panel/judge calls can be slow due to large context; validator is usually fast.
  return tool === "pi" ? 600_000 : 300_000;
}

// Bun's ShellPromise supports abortSignal at runtime but the types don't expose it yet.
function withSignal(promise: ShellPromise, signal: AbortSignal): ShellPromise {
  return (promise as unknown as { abortSignal(s: AbortSignal): ShellPromise }).abortSignal(signal);
}

export async function runCLIJSON<T>(opts: CliRunOptions, schema: z.ZodSchema<T>): Promise<T> {
  const raw = await runCLI(opts);
  const cleaned = raw
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return schema.parse(parsed);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(
        `[${opts.label ?? opts.tool}] JSON validation failed:\n${e.message}\n\nRaw:\n${cleaned.slice(0, 400)}`
      );
    }
    throw new Error(
      `[${opts.label ?? opts.tool}] Failed to parse JSON (${cleaned.length} chars): ${e instanceof Error ? e.message : String(e)}\n${cleaned.slice(0, 400)}`
    );
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────
// claude --print [--model <model>] --system-prompt <file> "<message>"

async function runClaude(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const systemFile = await writeTempFile(opts.systemPrompt!, "claude-system");
  try {
    const modelFlag  = opts.model ? ["--model", opts.model] : [];
    const result = await withSignal($`claude --print --no-interactive ${modelFlag} --system-prompt ${systemFile} ${opts.userMessage}`
      .cwd(opts.cwd ?? process.cwd())
      .nothrow(), signal);

    if (result.exitCode !== 0)
      throw new Error(`[${opts.label ?? "claude"}] exited ${result.exitCode}: ${result.stderr}`);

    return result.stdout.toString().trim();
  } finally {
    await fs.unlink(systemFile).catch(() => {});
  }
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────
// opencode run [--model <provider/model>] "<message>"
// No --system-prompt flag — prepend to user message

async function runOpenCode(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`;
  const modelFlag  = opts.model ? ["--model", opts.model] : [];

  const result = await withSignal($`opencode run ${modelFlag} ${fullPrompt}`
    .cwd(opts.cwd ?? process.cwd())
    .nothrow(), signal);

  if (result.exitCode !== 0)
    throw new Error(`[${opts.label ?? "opencode"}] exited ${result.exitCode}: ${result.stderr}`);

  return result.stdout.toString().trim();
}

// ─── Pi ───────────────────────────────────────────────────────────────────────
// pi --mode json [--model <model>] --system-prompt <file> "<message>"

async function runPi(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const systemFile = await writeTempFile(opts.systemPrompt!, "pi-system");
  try {
    const modelFlag  = opts.model ? ["--model", opts.model] : [];
    const result = await withSignal($`pi --mode json ${modelFlag} --system-prompt ${systemFile} ${opts.userMessage}`
      .cwd(opts.cwd ?? process.cwd())
      .nothrow(), signal);

    if (result.exitCode !== 0)
      throw new Error(`[${opts.label ?? "pi"}] exited ${result.exitCode}: ${result.stderr}`);

    return extractPiText(result.stdout.toString());
  } finally {
    await fs.unlink(systemFile).catch(() => {});
  }
}

// ─── Pi JSONL Parser ──────────────────────────────────────────────────────────

const MAX_PI_LINES = 100_000; // guard against runaway/garbage JSONL output

function extractPiText(jsonl: string): string {
  const lines = jsonl.split("\n").filter(Boolean).slice(0, MAX_PI_LINES);
  const textChunks: string[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        const last = event.messages.filter((m: any) => m.role === "assistant").at(-1);
        const text = extractContentText(last?.content);
        if (text) return text;
      }

      if (event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta") {
        textChunks.push(event.assistantMessageEvent.delta ?? "");
      }
    } catch {}
  }

  const accumulated = textChunks.join("");
  if (accumulated) return accumulated;
  throw new Error("[pi] Could not extract text from JSONL output");
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
  return "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function writeTempFile(content: string, prefix: string): Promise<string> {
  const p = path.join(os.tmpdir(), `council-${prefix}-${Date.now()}.txt`);
  await fs.writeFile(p, content, "utf-8");
  return p;
}
