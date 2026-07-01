# Hardening Plan — Perspective Council

> Born from the post-build architectural review (`docs/fixes-plan.md` reviews itself).
> Ordered by severity. Each phase is independently shippable. Each commit keeps the
> codebase compiling and tests green.

## Phase 1 — Make the default deployment safe (security / deployment)

These are the three "one `docker run` away from a problem" items. Do them first.

### 1.1 Auth every read endpoint + require a token when bound off-loopback
**Why:** `GET /api/state` and the `/ws` upgrade (`src/server/server.ts:39,45`) have no `authorized(req)` check, so they leak `repoPath`, `branch`, full panel analyses, validator reports, and the live log stream. The Dockerfile sets `COUNCIL_HOST=0.0.0.0` and `.env.example` leaves `COUNCIL_API_TOKEN` commented out, so out of the box the server is network-reachable with read endpoints unsigned and, because `!API_TOKEN ⇒ authorized() returns true` (`server.ts:23`), writes unsigned too.

**Scope:**
- `src/server/server.ts` — call `authorized(req)` (or a new `authorizedWs`) on `/api/state` and `/ws`.
- `src/server/server.ts` — change the `authorized()` semantics: when `HOST` is not `127.0.0.1`/`localhost` and `API_TOKEN` is empty, **refuse to start** and print a clear error ("Set COUNCIL_API_TOKEN when binding off-loopback, or omit COUNCIL_HOST to bind loopback"). Loopback-without-token stays the convenient local default.
- `Dockerfile` — stop forcing `COUNCIL_HOST=0.0.0.0` unconditionally; either bind loopback by default or `ENTRYPOINT`-guard that `COUNCIL_API_TOKEN` is set when `COUNCIL_HOST` is non-loopback.
- `.env.example` — uncomment the token by default and add a note.
- `README.md` — update the Docker section so the example sets a token, and document the off-loopback guard.

**Acceptance:**
- New test: off-loopback with no token fails to start with the expected message.
- New test: `GET /api/state` returns 401 when a token is set and no/ wrong bearer is sent; returns 200 with the right bearer.
- New test: loopback with no token still serves `/api/state`.

### 1.2 Sandbox `promptFile` (close the LFI primitive)
**Why:** `config/panelists.ts:82` does `path.resolve(configDir, agent.promptFile)` with no escape check. A `POST /api/config` (token-gated, but see 1.1) with `promptFile: "../../../../etc/passwd"` delivers the file's contents to an LLM as a system prompt, which then leaks out through the PR body. The sibling upload handler at `src/server/config-api.ts:72` already does the correct `target.startsWith(promptsDir + "/")` check — mirror it.

**Scope:**
- `config/panelists.ts` `resolvePrompt` — after resolving `filePath`, assert `filePath === configDir || filePath.startsWith(configDir + path.sep)`, else throw a typed `ConfigError("promptFile escapes config dir")`. Apply the same check to the greenfield variant path before `readFileSync`.
- Add a constant helper (e.g. `assertWithin(base, target)`) in a shared location and reuse it in `config-api.ts` upload so the two paths can't drift again.

**Acceptance:**
- Unit test: `loadConfig` with `promptFile: "../../../etc/passwd"` throws `ConfigError`.
- Unit test: with token gating on (1.1), `POST /api/config` carrying an escaping `promptFile` is rejected before any file read.
- Existing config tests still pass.

### 1.3 Stop passing the codebase through argv (prevent `E2BIG` on big repos)
**Why:** `src/core/cli-runner.ts` passes the entire serialized codebase (capped ~320k chars, `src/core/serializer.ts:14`) as a single shell argv element: `${opts.userMessage}` for `claude --print` (line 93) and as the whole `fullPrompt` for `opencode run` (line 111), and again for `pi --mode json` (line 131). On constrained containers this is a latent `E2BIG` / exit 127 on exactly the large maintenance targets the tool exists for. The system prompt is already routed through a temp file — route the user message the same way.

**Scope:**
- `src/core/cli-runner.ts` — add `writeTempFile(opts.userMessage, "user-message")` and pass the **path** to each CLI via the smallest change that each tool supports:
  - `claude`: write the user message to a temp file and read it via the tool's stdin or a `--input-file`-equivalent (check current `claude` CLI flag set; if none, pipe via stdin: `$\`claude --print ... --system-prompt ${systemFile} < ${userFile}\``).
  - `opencode`: same approach — `fullPrompt` goes into a temp file, fed via stdin.
  - `pi`: same.
  - Clean up temp files in `finally` alongside `systemFile`.
- If any CLI genuinely can't read the prompt from stdin/file, fall back to argv for small prompts (under a threshold, e.g. 8k chars) and throw a clear `PromptTooLargeForArgv` error otherwise — never silently truncate.

**Acceptance:**
- Integration-style test using a stub binary on `PATH` (see Phase 4) that a 300k-char `userMessage` reaches the tool intact via the file/stdin path.
- Existing agent tests/stubs still green.

---

## Phase 2 — Process & state robustness

### 2.1 Cancel a running pipeline + make the timeout cast honest
**Why:** `cli-runner.ts:60` casts `promise as unknown as { abortSignal(s: AbortSignal) }` — the comment admits the types don't expose it. If Bun renames it, timeouts silently stop working: the `AbortController` timer fires but does nothing, and a hung CLI runs to the full default timeout. Also there's no "cancel current run" endpoint — once `runPipeline` starts, the only abort point is the HIL gate.

**Scope:**
- `src/core/cli-runner.ts` — after the cast, assert the method exists (`typeof fn === "function"`); if not, fall back to `Bun.spawn` kill on timeout. Add a tiny test that the fallback path is taken when the method is absent (stub).
- `src/server/server.ts` — add `POST /api/run/abort` (token-gated) that sets a shared `AbortController` exposed from `store`/`runPipeline`; `cli-runner` already takes a `signal`, so wire it through `runPipeline` → each stage.
- `src/main.ts` — `runPipeline` creates and stores the `AbortController` on the store; cleanup in `finally`.

**Acceptance:**
- Test: aborting a run resolves the in-flight CLI call with a clear "aborted" error and clears `pipelineActive`.
- Test: the `withSignal` fallback path works when `abortSignal` is unavailable.

### 2.2 Fix Telegram `awaitingNotes` spurious-submit and callback auth
**Why:** `src/server/telegram.ts` — any non-`/` message from a chat with a pending `awaitingNotes` entry calls `submitHIL` (`telegram.ts:149`-152) with **no check that HIL is actually pending** and **no TTL**. `awaitingNotes` is never cleared on run boundaries, so a stray message days later writes a bogus `hilResponse` into the store and emits `hil_received`. `handleCallback` (`telegram.ts:265`) skips the `ALLOWED_CHAT_IDS` check that `handleMessage` enforces (`telegram.ts:143`).

**Scope:**
- `submitHIL` and the `awaitingNotes` path — guard on `store.getState()?.hilPending === true` before resolving; otherwise clear the entry and reply "no run awaiting review."
- Clear `awaitingNotes` for a chat on run start/abort/done (subscribe to store events or have `store.init` reset a callback).
- Add a TTL (e.g. 10 min) to `awaitingNotes` entries.
- `handleCallback` — add the same `ALLOWED_CHAT_IDS` guard as `handleMessage`.

**Acceptance:**
- Test: a stray message with no pending run does **not** call `store.setHILResponse`.
- Test: a callback from a disallowed chat is ignored.

### 2.3 Collapse "is a run active" to one definition
**Why:** `pipelineActive` (boolean in `main.ts`) and `currentStage !== done/aborted` (re-derived in `server.ts` `handleRun`) are two independent definitions of "active." They can drift if `setError` is ever called outside `runPipeline`.

**Scope:**
- Make `store` the single source of truth: expose `store.isIdle()` derived from `currentStage`, remove the `pipelineActive` boolean from `main.ts`, and have `handleRun` call `store.isIdle()` instead of re-reading raw JSON stage.

**Acceptance:**
- Test: re-entry protection still rejects a concurrent `POST /api/run`; a done/aborted run allows a new one.

---

## Phase 3 — Config schema hygiene

### 3.1 One schema source of truth
**Why:** `config/panelists.schema.json` says `panelists.minItems: 1`; Zod (`src/core/schemas.ts:157,166`) requires ≥2 active. `config/panelists.json` references the JSON schema via `$schema` but runtime validates with Zod. An editor using the JSON schema for validation will produce configs Zod rejects.

**Scope:**
- Decide: keep Zod as the truth, **generate** `panelists.schema.json` from it (Bun script using `zod-to-json-schema`) under a `bun run gen:schema` script wired into `test`/CI. Drop the hand-maintained JSON schema.
- Add a CI check that the committed JSON schema matches the generated one.
- `panelists.json` `$schema` comment updated.

**Acceptance:**
- `bun run gen:schema` regenerates the file; CI fails if it's out of sync.
- A config with 1 inactive panelist is rejected by both schemas consistently.

### 3.2 Consolidate `active` re-counting
**Why:** The "≥2 active" rule is enforced in Zod, re-counted in `main.ts`, and re-parsed raw in `server.ts` as a "safety net" — a smell that the conductor's own `loadConfig` isn't trusted.

**Scope:**
- Remove the server's redundant raw-JSON re-parse; trust `loadConfig`'s validated output. If a guard is still wanted at the API, have it call the same `loadConfig`.

**Acceptance:**
- Test: `POST /api/run` with <2 active returns the same error as before.

### 3.3 Hygiene: gitignore the binary, commit/handle the imported sources
**Why:** `git status` shows the 62 MB `council` Mach-O binary plus `src/config-embed.ts` and `src/types.d.ts` untracked and **not gitignored**. `config-embed.ts` is imported by `config/panelists.ts` and `server/config-api.ts` — a fresh clone after `git clean` won't compile.

**Scope:**
- `.gitignore` — add `council` (the compiled binary). Decide whether `src/config-embed.ts` and `src/types.d.ts` should be committed (if they're sources) — if not, remove the import.
- Fix `README.md:3` placeholder badge `/<owner>/<repo>/`.

**Acceptance:**
- `git clean -fdx && bun install && bun run typecheck` succeeds from a fresh clone.

---

## Phase 4 — Test the risky layers

The risky code is the untested code. Use the same real-`git`/real-`sh` pattern already in `tests/worktree.test.ts` and `tests/evaluate.test.ts`.

### 4.1 `cli-runner.ts` with stub binaries on PATH
- Fake `claude`, `opencode`, `pi` scripts on a temp `PATH` that echo args, read stdin, stream the `pi` JSONL shape including a malformed line and a missing `agent_end` case.
- Covers: argv-vs-file delivery (ties to 1.3), `extractPiText` malformed-line behavior, timeout path, and the `withSignal` cast fallback (2.1).

### 4.2 HTTP layer
- Start the real `Bun.serve` against an ephemeral port in tests; assert: `/api/state` and `/api/config` 401 without token (ties to 1.1), `/api/run` guards, WS requires auth, `POST /api/hil` resolution flows through the store.
- Use `fetch` against the started server.

### 4.3 Telegram bot
- Stub `tgCall` to return canned getUpdates sequences; assert: disallowed chat ignored, `awaitingNotes` TTL + no-pending-run guard (ties to 2.2), callback from disallowed chat ignored, HIL keyboard resolves into the store.

### 4.4 `utils/pr.ts` push + manual fallback
- Use a temp bare git repo as the "remote"; assert the impl branch is pushed and the manual fallback writes the PR body file with the audit trail, on success and when no forge CLI/token is present.

---

## Phase 5 — UI maintainability (larger; can defer behind 1–4)

### 5.1 Split + build the UI; bundle React locally; set a CSP
**Why:** `src/ui/index.html` is 1,931 lines — ~1,600 lines of inline `text/babel` JSX compiled in-browser by Babel-standalone **loaded from a public CDN** on every load (`index.html:9-11`), while holding `window.__COUNCIL_API_TOKEN__`. A compromised CDN/MITM gets full control of the token and the pipeline-launch/PR endpoints. No build step ⇒ no lint, types, tree-shaking, minification. `docs/SPEC-ui-redesign.md` already signals this is planned.

**Scope:**
- Introduce a minimal Vite (esbuild) build: split into modules under `src/ui/`, output a single bundle served by `src/server/server.ts`.
- Vendor React/ReactDOM/Babel away from CDN (or drop Babel entirely by precompiling JSX).
- Set a `Content-Security-Policy` on UI responses (script-src self).
- Stop injecting the token into the page; have the UI read it from a same-origin cookie or omit it and rely on loopback.

**Acceptance:**
- UI loads with no CDN usage; works offline.
- A CSP meta/http header is set and the page still functions.
- `docs/SPEC-ui-redesign.md` checklist reconciled.

---

## Out of scope for this plan

- New features (new agents, new forges beyond the four).
- The optional Rust migration path in `docs/PLAN.md`.
- Migrating off Bun's `$` shell for CLI invocation.
- Pinning agent CLI versions / capability detection (noted as a future risk; no clean mechanism today).

## Sequencing rationale

Phases 1–3 are small, surgical, and each shippable in isolation — Phase 1 closes the "open by default" exposure and the two LFI/E2BIG primitives. Phase 2 hardens the two stateful hotspots (`store`, `telegram`) and adds cancellation. Phase 3 is tidy-up that prevents future drift bugs. Phase 4 is the test backfill that lets 1–3 land safely and catches the next regression. Phase 5 is the largest single piece of work and is intentionally last — it's maintainability, not safety.

## Further notes

- Each fix lists concrete acceptance tests; convert each into a TDD red-green cycle (see the `tdd` skill) when implementing.
- After Phase 1.1 + 1.2 land, re-run the `review` skill against this branch to confirm the audit-trail changes hold up before proceeding.