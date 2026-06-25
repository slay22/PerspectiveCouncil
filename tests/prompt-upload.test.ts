import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { resolveConfigPath } from "../config/panelists.ts";
import { handleUploadPromptFile } from "../src/server/config-api.ts";

function fileReq(name: string, content: string, type = "text/markdown"): Request {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  return new Request("http://x/api/config/prompt-file", { method: "POST", body: form });
}

describe("POST /api/config/prompt-file", () => {
  const promptsDir = path.join(path.dirname(resolveConfigPath()), "prompts");
  const created: string[] = [];

  beforeEach(() => {
    if (!fs.existsSync(promptsDir)) fs.mkdirSync(promptsDir, { recursive: true });
  });
  afterEach(() => {
    for (const f of created) {
      try { fs.unlinkSync(f); } catch {}
    }
    created.length = 0;
  });

  it("writes a valid .md file and returns its path", async () => {
    const res = await handleUploadPromptFile(fileReq("test-upload-1.md", "# hello\n"));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.path).toBe("./prompts/test-upload-1.md");

    const target = path.join(promptsDir, "test-upload-1.md");
    created.push(target);
    expect(fs.readFileSync(target, "utf-8")).toBe("# hello\n");
  });

  it("sanitises filenames with special characters", async () => {
    const res = await handleUploadPromptFile(fileReq("../../etc/passwd.md", "x"));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.path).toBe("./prompts/.._.._etc_passwd.md");
    created.push(path.join(promptsDir, ".._.._etc_passwd.md"));
  });

  it("rejects non-.md files", async () => {
    const res = await handleUploadPromptFile(fileReq("evil.exe", "x"));
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/only \.md/i);
  });

  it("rejects empty files", async () => {
    const res = await handleUploadPromptFile(fileReq("empty.md", ""));
    expect(res.status).toBe(400);
  });

  it("rejects oversize files", async () => {
    const big = "x".repeat(257 * 1024);
    const res = await handleUploadPromptFile(fileReq("huge.md", big));
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/too large/i);
  });

  it("rejects missing file field", async () => {
    const form = new FormData();
    form.append("other", "value");
    const res = await handleUploadPromptFile(new Request("http://x/api/config/prompt-file", {
      method: "POST", body: form,
    }));
    expect(res.status).toBe(400);
  });

  it("accepts .markdown extension", async () => {
    const res = await handleUploadPromptFile(fileReq("note.markdown", "# x"));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.path).toBe("./prompts/note.md"); // normalised to .md
    created.push(path.join(promptsDir, "note.md"));
  });
});
