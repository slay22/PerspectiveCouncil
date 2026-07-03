import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import { buildFetchHandler, authorized, authorizedWs, assertSafeBind } from "../src/server/server.ts";
import { readCouncilConfig } from "../config/panelists.ts";

// ─── Pure auth helpers ───────────────────────────────────────────────────────

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

describe("assertSafeBind", () => {
  it("allows loopback without a token", () => {
    expect(() => assertSafeBind("127.0.0.1", "")).not.toThrow();
    expect(() => assertSafeBind("localhost", "")).not.toThrow();
    expect(() => assertSafeBind("::1", "")).not.toThrow();
  });

  it("allows non-loopback when a token is set", () => {
    expect(() => assertSafeBind("0.0.0.0", "secret")).not.toThrow();
  });

  it("refuses non-loopback without a token", () => {
    expect(() => assertSafeBind("0.0.0.0", "")).toThrow(/Refusing to bind/);
  });
});

describe("authorized (HTTP)", () => {
  it("allows everything when no token is configured", () => {
    expect(authorized(req("/api/state"), "")).toBe(true);
    expect(authorized(req("/api/state", { headers: { authorization: "Bearer wrong" } }), "")).toBe(true);
  });

  it("rejects requests with no/wrong bearer when a token is set", () => {
    expect(authorized(req("/api/state"), "secret")).toBe(false);
    expect(authorized(req("/api/state", { headers: { authorization: "Bearer wrong" } }), "secret")).toBe(false);
  });

  it("accepts the correct bearer", () => {
    expect(authorized(req("/api/state", { headers: { authorization: "Bearer secret" } }), "secret")).toBe(true);
  });
});

describe("authorizedWs (WebSocket)", () => {
  it("allows everything when no token is configured", () => {
    expect(authorizedWs(req("/ws"), "")).toBe(true);
  });

  it("accepts the Authorization header", () => {
    expect(authorizedWs(req("/ws", { headers: { authorization: "Bearer secret" } }), "secret")).toBe(true);
  });

  it("accepts the ?token= query param (browser path)", () => {
    expect(authorizedWs(req("/ws?token=secret"), "secret")).toBe(true);
  });

  it("rejects a wrong query param and wrong header", () => {
    expect(authorizedWs(req("/ws?token=wrong"), "secret")).toBe(false);
    expect(authorizedWs(req("/ws", { headers: { authorization: "Bearer wrong" } }), "secret")).toBe(false);
  });
});

// ─── Routing via the extracted fetch handler ─────────────────────────────────
// No real socket is bound — the handler is called directly with a fake `server`.

const noopServer = { upgrade: () => true };

describe("buildFetchHandler routing + auth", () => {
  it("GET /api/state is 401 when a token is set and no bearer is sent", async () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/state"), noopServer) as Response;
    expect(res.status).toBe(401);
  });

  it("GET /api/state is 200 with the correct bearer", async () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/state", { headers: { authorization: "Bearer secret" } }), noopServer) as Response;
    expect(res.status).toBe(200);
    // Either the run state or the { error: "No run active" } fallback.
    const body = await res.json();
    expect(body).toBeObject();
  });

  it("GET /api/state is open (200) when no token is configured (loopback local)", async () => {
    const handler = buildFetchHandler("");
    const res = handler(req("/api/state"), noopServer) as Response;
    expect(res.status).toBe(200);
  });

  it("/ws upgrade is 401 when the token is set and no token is provided", () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/ws"), noopServer) as Response;
    expect(res.status).toBe(401);
  });

  it("/ws upgrade proceeds (?token=) when the token matches", () => {
    const handler = buildFetchHandler("secret");
    const upgraded = handler(req("/ws?token=secret"), noopServer);
    // upgrade() returned true ⇒ handler returns undefined (the Bun convention).
    expect(upgraded).toBeUndefined();
  });

  it("POST /api/run is 401 without the correct bearer", async () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/run", { method: "POST", body: "{}" }), noopServer) as Response;
    expect(res.status).toBe(401);
  });

  it("GET /api/config is 401 without the correct bearer", () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/config"), noopServer) as Response;
    expect(res.status).toBe(401);
  });

  it("POST /api/run/abort is 401 without the correct bearer", async () => {
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/run/abort", { method: "POST" }), noopServer) as Response;
    expect(res.status).toBe(401);
  });

  it("POST /api/run/abort with a token returns 200 + a boolean ok flag", async () => {
    // The store is a process-global singleton; its idle/active state depends
    // on test ordering. We assert routing + auth + shape, not the boolean
    // value (store-abort.test.ts covers the idle/active semantics directly).
    const handler = buildFetchHandler("secret");
    const res = handler(req("/api/run/abort", { method: "POST", headers: { authorization: "Bearer secret" } }), noopServer) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(typeof body.ok).toBe("boolean");
  });
});

// ─── /vendor/* static serving (React + Babel bundle) ────────────────────────
// Same-origin JS bundle static-served from src/ui/vendor/. No auth — these are
// public-same-origin assets equivalent to the CDN scripts they replaced.

describe("buildFetchHandler /vendor/*", () => {
  const handler = buildFetchHandler("");

  it("serves react.production.min.js with the right content-type", async () => {
    const res = handler(req("/vendor/react.production.min.js"), noopServer) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    // Sanity: real React UMD, starts with the license header.
    expect(body).toMatch(/react\.production\.min\.js|Facebook, Inc/);
  });

  it("rejects traversal attempts", () => {
    // URL canonicalization collapses ".." segments before we see them — it
    // never reaches the vendor handler, so it falls through to the 404
    // catch-all. The important safety net is the basename guard, exercised
    // by the empty-segment case below.
    expect((handler(req("/vendor/../server.ts"), noopServer) as Response).status).toBe(404);
    // Explicitly empty segment (e.g. "/vendor/") must be rejected, not served.
    expect((handler(req("/vendor/"), noopServer) as Response).status).toBe(403);
  });

  it("returns 404 for missing files inside the vendor dir", () => {
    const res = handler(req("/vendor/does-not-exist.js"), noopServer) as Response;
    expect(res.status).toBe(404);
  });

  it("does NOT require auth even when a token is configured", async () => {
    const guarded = buildFetchHandler("secret");
    const res = guarded(
      req("/vendor/react-dom.production.min.js"),
      noopServer,
    ) as Response;
    expect(res.status).toBe(200);
  });
});
// ─── /api/run safety net: <2 active panelists rejected before launching ──────
// The guard's root is readCouncilConfig(); the full HTTP path is gated on the
// store singleton / pipelineRunner registration, which makes the end-to-end
// variant order-dependent. Unit-test the guard logic directly instead.

describe("readCouncilConfig active-count guard (shared with /api/run + loadConfig)", () => {
  let dir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(os.tmpdir() + "/council-guard-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Pass an explicit configPath so the tests never touch the real
  // config/panelists.json (resolveConfigPath prefers the source copy when no
  // path is given, which would couple these tests to global file state).
  const cfg = () => dir + "/panelists.json";
  const write = (panelists: unknown) =>
    fs.writeFileSync(cfg(), JSON.stringify({
      panelists,
      judge:     { tool: "pi",     label: "Judge",     systemPrompt: "j" },
      validator: { tool: "claude", label: "Validator", systemPrompt: "v" },
    }, null, 2), "utf-8");

  it("throws ZodError (≥2-active refine) for a hand-edited <2-active config", () => {
    // Write directly — saveConfig would refuse this; the runtime guard is the
    // safety net for hand-edited or stale-embedded configs.
    write([
      { id: "a", label: "A", tool: "claude", systemPrompt: "x", active: true },
      { id: "b", label: "B", tool: "pi",     systemPrompt: "y", active: false },
    ]);
    expect(() => readCouncilConfig(cfg())).toThrow(/At least 2 panelists must be active/);
  });

  it("parses cleanly when ≥2 are active", () => {
    write([
      { id: "a", label: "A", tool: "claude", systemPrompt: "x" },
      { id: "b", label: "B", tool: "pi",     systemPrompt: "y" },
    ]);
    const { council } = readCouncilConfig(cfg());
    expect(council.panelists.filter((p: { active?: boolean }) => p.active !== false).length).toBe(2);
  });
});
