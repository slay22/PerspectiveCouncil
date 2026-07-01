import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { runCLI } from "../src/core/cli-runner.ts";

// ─── Stub binaries on a temp PATH so runCLI never calls a real agent CLI ──────
// Each stub ignores its flags, reads stdin, and echoes it back (pi wraps it in
// the JSONL shape extractPiText understands). This proves the full user message
// reaches the tool via stdin/file redirection regardless of size — argv is never
// the carrier, so a ~320k-char codebase cannot E2BIG.

let dir = "";
let savedPath = "";

async function dirStub(name: string, lines: string[]): Promise<void> {
  const body = lines.join("\n") + "\n";
  await fs.writeFile(path.join(dir, name), body, { mode: 0o755 });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-cli-"));
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${savedPath}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  await fs.rm(dir, { recursive: true, force: true });
});

const BIG = "A".repeat(300_000); // ~300k chars — would blow macOS ARG_MAX (256k)

describe("runCLI routes the user message via stdin (not argv)", () => {
  it("claude receives the full payload via stdin", async () => {
    await dirStub("claude", ["#!/bin/sh", "cat"]);
    const out = await runCLI({
      tool: "claude", systemPrompt: "sys", userMessage: BIG, cwd: dir,
    });
    expect(out).toBe(BIG);
  });

  it("opencode receives the full payload (system prepended) via stdin", async () => {
    await dirStub("opencode", ["#!/bin/sh", "cat"]);
    const out = await runCLI({
      tool: "opencode", systemPrompt: "SYS-MARKER", userMessage: BIG, cwd: dir,
    });
    expect(out.startsWith("SYS-MARKER\n\n---\n\n")).toBe(true);
    expect(out.endsWith(BIG)).toBe(true);
  });

  it("pi receives the full payload via stdin (JSONL-wrapped)", async () => {
    // Output a single agent_end JSONL event with the assistant content set to
    // the (quoted) stdin. BIG is only 'A' chars, so it's valid JSON unescaped.
    await dirStub("pi", [
      "#!/bin/sh",
      "printf '{\"type\":\"agent_end\",\"messages\":[{\"role\":\"assistant\",\"content\":\"'",
      "cat",
      "printf '\"}]}'",
      "echo",
    ]);
    const out = await runCLI({
      tool: "pi", systemPrompt: "sys", userMessage: BIG, cwd: dir,
    });
    expect(out).toBe(BIG);
  });

  it("a non-zero exit is surfaced with stderr", async () => {
    await dirStub("claude", ["#!/bin/sh", "echo 'boom' >&2", "exit 1"]);
    await expect(runCLI({
      tool: "claude", systemPrompt: "sys", userMessage: "x", cwd: dir,
    })).rejects.toThrow(/exited 1/);
  });

  it("a timeout aborts and surfaces a timeout error", async () => {
    await dirStub("claude", ["#!/bin/sh", "sleep 30"]);
    await expect(runCLI({
      tool: "claude", systemPrompt: "sys", userMessage: "x", cwd: dir,
      timeoutMs: 150,
    })).rejects.toThrow(/timed out after 150ms/);
  });
});