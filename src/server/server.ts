import { readFileSync } from "fs";
import * as path from "path";
import { HILResponseSchema, RunRequestSchema } from "../core/schemas.ts";
import { store } from "./store.ts";
import { handleGetConfig, handlePostConfig } from "./config-api.ts";
import type { HILResponse } from "../core/types.ts";
import type { ConductorConfig } from "../main.ts";

const UI_PATH = path.join(import.meta.dir, "../ui/index.html");
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

      if (url.pathname === "/" || url.pathname === "/index.html") {
        try {
          const html = readFileSync(UI_PATH, "utf-8");
          // Hand the same-origin UI the token so its fetches can authenticate.
          const injected = html.replace(
            "</head>",
            `<script>window.__COUNCIL_API_TOKEN__=${JSON.stringify(API_TOKEN)};</script></head>`
          );
          return new Response(injected, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch {
          return new Response("UI not found", { status: 404 });
        }
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
