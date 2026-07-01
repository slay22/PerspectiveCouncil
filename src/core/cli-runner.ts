import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import type { CliTool } from "./schemas.ts";

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
  parentSignal?: AbortSignal | undefined; // run-level cancel; aborts the child
  extraArgs?:   string[] | undefined; // extra argv appended (e.g. --allowedTools)
}

// ─── Unified Runner ───────────────────────────────────────────────────────────

export async function runCLI(opts: CliRunOptions): Promise<string> {
  if (!opts.systemPrompt || opts.systemPrompt.trim() === "") {
    throw new Error(`[${opts.label ?? opts.tool}] systemPrompt is required`);
  }

  const timeoutMs = opts.timeoutMs ?? defaultTimeoutFor(opts.tool);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Link an external (run-level) cancel signal: when the parent aborts, abort
  // our internal controller so spawnCli kills the child. Either route fires.
  const parentSignal = opts.parentSignal;
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  try {
    return await runCLIInner(opts, controller.signal);
  } catch (e) {
    // A cancel/timeout aborts the internal controller; spawnCli surfaces that as
    // a thrown error after the killed process exits. Distinguish the two:
    // a parent-initiated abort is a cancel; otherwise it's our timeout.
    if (controller.signal.aborted) {
      if (parentSignal?.aborted) {
        throw new Error(`[${opts.label ?? opts.tool}] run cancelled`);
      }
      throw new Error(`[${opts.label ?? opts.tool}] CLI call timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
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

// ─── Spawn helper ─────────────────────────────────────────────────────────────
// Uses Bun.spawn directly (not the `$` shell) so we can: (a) feed the prompt via
// a file on stdin without an argv element (avoids E2BIG on big codebases), and
// (b) implement a real timeout/cancel by killing the child process on abort.
// The old code cast the ShellPromise to an `abortSignal` method that does not
// exist in current Bun, so timeouts never worked and every call would throw.

interface SpawnArgs {
  cmd:      string[];   // argv array (no shell parsing)
  cwd?:     string;
  stdinFile: string;   // file piped to the child's stdin
  signal:   AbortSignal;
  label:    string;
}

// Bun.spawn does not re-resolve PATH from a runtime-mutated process.env.PATH
// (it uses the value captured at process start), so resolve the binary name
// manually against the current PATH. Falls back to the bare name so Bun's
// native resolution still applies when nothing is found.
function resolveOnPath(name: string): string {
  if (name.includes(path.sep)) return name;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) return candidate;
    } catch { /* not present */ }
  }
  return name;
}

async function spawnCli(args: SpawnArgs): Promise<string> {
  // stdout/stderr go to temp files (not pipes) so that: (a) a child that writes
  // more than the pipe buffer (the ~300k-char codebase) can't deadlock us, and
  // (b) when a timeout kills the parent shell, an orphaned grandchild that
  // inherits the pipe fd can't keep our drain from reaching EOF.
  const outFile = await writeTempFile("", "out");
  const errFile = await writeTempFile("", "err");
  const proc = Bun.spawn({
    cmd:    [resolveOnPath(args.cmd[0] ?? ""), ...args.cmd.slice(1)],
    cwd:    args.cwd,
    stdin:  Bun.file(args.stdinFile),
    stdout: Bun.file(outFile),
    stderr: Bun.file(errFile),
  });

  const onAbort = () => { try { proc.kill("SIGTERM"); } catch { /* already exited */ } };
  args.signal.addEventListener("abort", onAbort, { once: true });
  const exitCode = await proc.exited;
  args.signal.removeEventListener("abort", onAbort);

  const stdout = await fs.readFile(outFile, "utf-8").catch(() => "");
  const stderr = await fs.readFile(errFile, "utf-8").catch(() => "");
  await fs.unlink(outFile).catch(() => {});
  await fs.unlink(errFile).catch(() => {});

  if (args.signal.aborted) {
    throw new Error(`[${args.label}] aborted`);
  }
  if (exitCode !== 0) {
    throw new Error(`[${args.label}] exited ${exitCode}: ${stderr.trim()}`);
  }
  return stdout.trim();

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
// claude --print [--model <model>] --system-prompt-file <file>   (prompt via stdin)
// The serialized codebase can be ~320k chars — far too large for a single argv
// element on some hosts (macOS ARG_MAX, small containers → E2BIG/exit 127), so
// the user message is written to a temp file and piped to claude's stdin, which
// --print treats as the prompt when no positional prompt is supplied.
// Note: --system-prompt takes TEXT; --system-prompt-file takes a PATH. The old
// code passed a path to --system-prompt, sending the literal path string as the
// system prompt — fixed here.

async function runClaude(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const systemFile = await writeTempFile(opts.systemPrompt!, "claude-system");
  const userFile   = await writeTempFile(opts.userMessage, "claude-user");
  try {
    const cmd = [
      "claude", "--print",  // --print is already non-interactive; old --no-interactive was rejected by claude.
      ...(opts.model ? ["--model", opts.model!] : [] as string[]),
      "--system-prompt-file", systemFile,
      ...(opts.extraArgs ?? [] as string[]),  // e.g. --allowedTools, --add-dir
    ];
    return await spawnCli({
      cmd, cwd: opts.cwd, stdinFile: userFile, signal,
      label: opts.label ?? "claude",
    });
  } finally {
    await fs.unlink(systemFile).catch(() => {});
    await fs.unlink(userFile).catch(() => {});
  }
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────
// opencode run [--model <provider/model>]   (prompt via stdin)
// No --system-prompt flag — prepend system prompt to the user message, then
// pipe the combined prompt via stdin (avoiding argv size limits).

async function runOpenCode(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const fullPrompt = `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`;
  const userFile   = await writeTempFile(fullPrompt, "opencode-user");
  try {
    const cmd = [
      "opencode", "run",
      ...(opts.model ? ["--model", opts.model!] : [] as string[]),
    ];
    const raw = await spawnCli({
      cmd, cwd: opts.cwd, stdinFile: userFile, signal,
      label: opts.label ?? "opencode",
    });
    return raw;
  } finally {
    await fs.unlink(userFile).catch(() => {});
  }
}

// ─── Pi ───────────────────────────────────────────────────────────────────────
// pi --mode json [--model <model>] --system-prompt <text>   (prompt via stdin)
// Pi has no --system-prompt-FILE flag, so the system prompt is passed inline as
// text (prompt files are small enough for argv); the user message is piped via
// stdin. The old code passed a temp-file PATH to --system-prompt, sending the
// literal path as the system prompt — fixed here.

async function runPi(opts: CliRunOptions, signal: AbortSignal): Promise<string> {
  const userFile  = await writeTempFile(opts.userMessage, "pi-user");
  try {
    const cmd = [
      "pi", "--mode", "json",
      ...(opts.model ? ["--model", opts.model!] : [] as string[]),
      "--system-prompt", String(opts.systemPrompt),
    ];
    const raw = await spawnCli({
      cmd, cwd: opts.cwd, stdinFile: userFile, signal,
      label: opts.label ?? "pi",
    });
    return extractPiText(raw);
  } finally {
    await fs.unlink(userFile).catch(() => {});
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

let tempSeq = 0;

export async function writeTempFile(content: string, prefix: string): Promise<string> {
  // Unique across parallel panelist runs (which run concurrently).
  const p = path.join(os.tmpdir(), `council-${prefix}-${Date.now()}-${tempSeq++}.txt`);
  await fs.writeFile(p, content, "utf-8");
  return p;
}
