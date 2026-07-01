import { describe, it, expect } from "bun:test";
import { buildFetchHandler, authorized, authorizedWs, assertSafeBind } from "../src/server/server.ts";

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