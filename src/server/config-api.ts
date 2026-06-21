import { readFileSync } from "fs";
import { CONFIG_PATH, saveConfig } from "../../config/panelists.ts";

// ─── GET /api/config ──────────────────────────────────────────────────────────

export function handleGetConfig(): Response {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return json(JSON.parse(raw));
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
