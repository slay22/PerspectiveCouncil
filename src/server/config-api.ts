import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve as resolvePath } from "path";
import { resolveConfigPath, saveConfig, assertWithin } from "../../config/panelists.ts";
import { getEmbeddedConfig } from "../config-embed.ts";

// ─── GET /api/config ──────────────────────────────────────────────────────────

export function handleGetConfig(): Response {
  try {
    const configPath = resolveConfigPath();
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      return json(JSON.parse(raw));
    }
    // Compiled binary with no sidecar config: return the bundled defaults.
    return json(getEmbeddedConfig("maintenance"));
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// ─── POST /api/config ─────────────────────────────────────────────────────────

export async function handlePostConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    saveConfig(body);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

// ─── POST /api/config/prompt-file ────────────────────────────────────────────
// Accepts a single .md file (multipart/form-data, field "file") and writes it
// next to the config file at ./prompts/<filename>. Returns the relative path
// the form should store. Path-traversal-safe: filename is sanitised to
// [\w.-]+, max 80 chars, and resolved under config/prompts/.

const MAX_PROMPT_BYTES = 256 * 1024;

export async function handleUploadPromptFile(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const entry = form.get("file");
    if (!entry || typeof entry === "string") {
      return json({ error: 'No file uploaded (form field must be named "file")' }, 400);
    }
    const file = entry as File;

    // Size checks first — the .name property can be missing in edge cases
    // (Bun's Request FormData round-trip drops it for empty files).
    if (file.size === 0) {
      return json({ error: "File is empty" }, 400);
    }
    if (file.size > MAX_PROMPT_BYTES) {
      return json({ error: `File too large (max ${MAX_PROMPT_BYTES / 1024} KiB)` }, 400);
    }

    // Derive a safe filename. Fall back to "prompt.md" if name is missing.
    const original = (file.name || "prompt.md").toLowerCase();
    if (!original.endsWith(".md") && !original.endsWith(".markdown")) {
      return json({ error: "Only .md files are allowed" }, 400);
    }
    let safe = (file.name || "prompt.md").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "prompt.md";
    safe = safe.replace(/\.markdown$/i, ".md");
    if (!/\.md$/i.test(safe)) safe = "prompt.md";

    // Resolve target under config/prompts/ — refuse to escape.
    const configPath = resolveConfigPath();
    const promptsDir = resolvePath(join(dirname(configPath), "prompts"));
    mkdirSync(promptsDir, { recursive: true });
    const target = resolvePath(join(promptsDir, safe));
    try {
      assertWithin(promptsDir, target);
    } catch {
      return json({ error: "Invalid filename" }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(target, buf);

    return json({ ok: true, path: `./prompts/${safe}` });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}
