import * as path from "path";
import { HILResponseSchema, RunRequestSchema, CouncilConfigSchema } from "../core/schemas.ts";
import { resolveConfigPath } from "../../config/panelists.ts";
import { store } from "./store.ts";
import { handleGetConfig, handlePostConfig, handleUploadPromptFile } from "./config-api.ts";
import uiHtml from "../ui/index.html" with { type: "text" };
import type { HILResponse } from "../core/types.ts";
import type { ConductorConfig } from "../main.ts";
const sockets = new Set<ServerWebSocket<unknown>>();
type ServerWebSocket<T> = import("bun").ServerWebSocket<T>;

// Injected by main so the UI can launch runs; null until registered.
let pipelineRunner: ((config: ConductorConfig) => Promise<void>) | null = null;
export function registerPipelineRunner(fn: (config: ConductorConfig) => Promise<void>): void {
  pipelineRunner = fn;
}

// Default to loopback so the server is not reachable from other hosts.
// Set COUNCIL_HOST=0.0.0.0 to expose it deliberately.
const HOST = process.env.COUNCIL_HOST ?? "127.0.0.1";
// When set, mutating/config endpoints require `Authorization: Bearer <token>`.
const API_TOKEN = process.env.COUNCIL_API_TOKEN ?? "";

function authorized(req: Request): boolean {
  if (!API_TOKEN) return true; // loopback bind is the protection when no token set
  return req.headers.get("authorization") === `Bearer ${API_TOKEN}`;
}

const UNAUTHORIZED = () => json({ error: "Unauthorized" }, 401);

export function startServer(port = 3000): void {
  try {
    Bun.serve({
      port,
      hostname: HOST,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        return json(store.getState() ?? { error: "No run active" });
      }

      if (url.pathname === "/api/hil" && req.method === "POST") {
        if (!authorized(req)) return UNAUTHORIZED();
        return handleHIL(req);
      }

      if (url.pathname === "/api/run" && req.method === "POST") {
        if (!authorized(req)) return UNAUTHORIZED();
        return handleRun(req);
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        if (!authorized(req)) return UNAUTHORIZED();
        return handleGetConfig();
      }

      if (url.pathname === "/api/config" && req.method === "POST") {
        if (!authorized(req)) return UNAUTHORIZED();
        return handlePostConfig(req);
      }

      if (url.pathname === "/api/config/prompt-file" && req.method === "POST") {
        if (!authorized(req)) return UNAUTHORIZED();
        return handleUploadPromptFile(req);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        // Hand the same-origin UI the token so its fetches can authenticate.
        const injected = (uiHtml as unknown as string).replace(
          "</head>",
          `<script>window.__COUNCIL_API_TOKEN__=${JSON.stringify(API_TOKEN)};</script></head>`
        );
        return new Response(injected, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        const state = store.getState();
        if (state) ws.send(JSON.stringify({ type: "state_snapshot", payload: state }));
      },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
    });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (/address|port|in use|EADDRINUSE/i.test(errMsg)) {
      console.error(`\n  ✗ Could not bind ${HOST}:${port} — port already in use.`);
      console.error(`    Pass --port <n> or set COUNCIL_PORT=<n> to use a different port.\n`);
      process.exit(1);
    }
    throw e;
  }

  store.subscribe((event) => {
    const msg = JSON.stringify(event);
    for (const ws of sockets) {
      try { ws.send(msg); } catch { sockets.delete(ws); }
    }
  });

  console.log(`\n  🌐 GUI → http://localhost:${port}`);
  openBrowser(`http://localhost:${port}`);
}

async function handleHIL(req: Request): Promise<Response> {
  try {
    const body = await req.json() as HILResponse;
    const validated = HILResponseSchema.parse(body);
    store.setHILResponse(validated);
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

async function handleRun(req: Request): Promise<Response> {
  if (!pipelineRunner) return json({ error: "Run launcher unavailable" }, 503);

  // Reject overlapping runs (the store is a single-run singleton).
  const active = store.getState();
  if (active && active.currentStage !== "done" && active.currentStage !== "aborted") {
    return json({ error: "A run is already in progress" }, 409);
  }

  let req2;
  try {
    req2 = RunRequestSchema.parse(await req.json());
  } catch (e) {
    return json({ error: String(e) }, 400);
  }

  // Safety net: re-validate that the persisted config has ≥ 2 active
  // panelists. The Config UI's Zod refine catches this at save time, but
  // a hand-edited panelists.json (or a stale embedded config in the
  // compiled binary) might bypass it. Read the active count without
  // re-running the full loadConfig (which needs worktreeBase + runId).
  try {
    const raw = await import("fs/promises").then((m) => m.readFile(resolveConfigPath(), "utf-8"));
    const parsed = CouncilConfigSchema.parse(JSON.parse(raw));
    const activeCount = parsed.panelists.filter((p) => p.active !== false).length;
    if (activeCount < 2) {
      return json({
        error: `At least 2 panelists must be active (currently ${activeCount}). ` +
               `Edit config/panelists.json or use the Config tab.`,
      }, 400);
    }
  } catch (e) {
    // If reading the config fails for any reason, fall through to the
    // run attempt — the conductor's loadConfig will surface a clear error.
  }

  const config: ConductorConfig = {
    repoPath:       path.resolve(req2.repoPath),
    branch:         req2.branch || "main",
    projectContext: req2.projectContext,
    ...(req2.mode ? { mode: req2.mode } : {}),
    ...(req2.specPath ? { specPath: path.resolve(req2.specPath) } : {}),
  };

  // Fire-and-forget: progress streams over the WebSocket.
  pipelineRunner(config).catch((e) => console.error("[run] pipeline error:", e));
  return json({ ok: true });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function openBrowser(url: string): Promise<void> {
  const cmds: Record<string, string[]> = {
    darwin: ["open", url], linux: ["xdg-open", url], win32: ["cmd", "/c", "start", url],
  };
  try {
    const cmd = cmds[process.platform] ?? cmds.linux;
    if (cmd) Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  }
  catch {}
}
