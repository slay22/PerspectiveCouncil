# Perspective Council — Fix Plan

> **Status:** Phases 1–3 implemented, plus a web-based config editor. Run `bun test` and `bun run typecheck` to verify.

This plan addresses the issues identified in the project review. It is split into phases by priority. Each item includes the file(s) to change and the expected outcome.

---

## Phase 1 — Critical Safety & Cleanup ✅

> Goal: remove the risk of data loss, shell injection, and repository pollution before any real usage.

### 1.1 Sanitize implementor shell invocation
**Files:** `src/agents/implementor.ts`

**Problem:** `instruction` is an untrusted LLM-generated string interpolated into a Bun `$` template literal. Even though `$` quotes strings, long multi-line instructions with quotes/backticks are risky.

**Fix:**
- Write the full instruction to a temp file.
- Invoke Claude Code with `--system-prompt <file>` (or pass the instruction via a file arg) so it is never parsed by the shell.
- Keep `--allowedTools "Edit,Write,Read,MultiEdit"` and `--add-dir ${worktreePath}`.

**Acceptance:** A judge plan containing backticks, quotes, and newlines executes without shell errors or injection.

---

### 1.2 Validate the judge's JSON plan at runtime
**Files:** `src/agents/judge.ts`, new `src/core/plan-schema.ts`

**Problem:** `runCLIJSON` parses raw LLM output but never checks it matches `JudgePlan`. Missing fields crash downstream code.

**Fix:**
- Introduce a runtime schema validator (Zod is recommended; it matches TypeScript well).
- Define `JudgePlanSchema` covering `summary`, `tasks` (with `id`, `file`, `action`, `instruction`, `rationale`, `priority`, `source`), `riskFlags`, and `outOfScope`.
- In `runJudge`, parse then validate; on failure, log the raw response and throw a clear error.

**Acceptance:** A malformed plan from the judge produces a readable error instead of a downstream crash.

---

### 1.3 Fix implementor worktree cleanup
**Files:** `src/main.ts`, `src/core/worktree.ts`

**Problem:** `cleanup()` ignores `_implPath` and only removes panelist worktrees, leaving `council/impl-*` branches and worktrees behind.

**Fix:**
- Add `removeImplementorWorktree(repoPath, implPath)` in `src/core/worktree.ts` that:
  1. Reads the current branch in the worktree.
  2. Removes the worktree with `git worktree remove --force`.
  3. Deletes the implementation branch from the main repo.
- Call it in the `abort` path and in the `finally`/catch handler of `runPipeline`.
- Ensure cleanup still runs even when earlier stages throw.

**Acceptance:** After a run (success, abort, or error), no `council/impl-*` branch or worktree remains.

---

### 1.4 Handle panelist failures gracefully
**Files:** `src/agents/panel.ts`, `src/core/types.ts` (optional)

**Problem:** `Promise.all(panelists.map(runPanelist))` loses partial results if one panelist fails.

**Fix:**
- Switch to `Promise.allSettled`.
- Collect successes and failures separately.
- Store failures via `store.panelistError(id, reason)`.
- Pass successful results to the judge; if all fail, stop the pipeline with a clear error.

**Acceptance:** If one panelist CLI exits with an error, the other two results are still used and the UI shows which panelist failed.

---

## Phase 2 — Robustness ✅

> Goal: make the pipeline resilient to slow networks, hung CLIs, and malformed model output.

### 2.1 Add timeouts to external CLI calls
**Files:** `src/core/cli-runner.ts`

**Problem:** `claude --print`, `opencode run`, and `pi` can hang indefinitely.

**Fix:**
- Wrap each `$` invocation in `Promise.race` with a configurable timeout.
- Default timeout: 10 minutes for panel/judge, 5 minutes for validator.
- On timeout, kill the child process and throw a `TimeoutError`.
- Allow override via `config.panelists.json` or env vars.

**Acceptance:** A hung panelist process is killed after the timeout and the pipeline reports the failure clearly.

---

### 2.2 Fix Telegram polling rate
**Files:** `src/server/telegram.ts`

**Problem:** The polling loop tail-recurses with no delay on success, hammering Telegram's API.

**Fix:**
- Always `await sleep(1000)` (or use `setTimeout`) between poll requests, even on success.
- Keep the existing 30-second long-poll timeout.

**Acceptance:** Polling continues but never exceeds ~1 request per second in error-free operation.

---

### 2.3 Harden panelist output parsing
**Files:** `src/agents/panel.ts`

**Problem:** `extractKeyFindings` and `extractRiskLevel` rely on fragile regex over free text.

**Fix:**
- Request structured JSON output from panelists by updating their system prompts (or by appending an output-format instruction).
- Parse the JSON and extract `keyFindings` and `riskLevel` directly.
- Keep a fallback regex parser for backwards compatibility, but log a warning when it is used.

**Acceptance:** Panelists returning the requested JSON format produce reliable findings and risk levels.

---

### 2.4 Scope worktrees and state by run ID
**Files:** `src/core/worktree.ts`, `src/main.ts`

**Problem:** Panelist worktree paths are fixed (`council-${p.id}`), so concurrent runs collide.

**Fix:**
- Include `runId` in all worktree paths: `council-${runId}-${p.id}` and `council-impl-${runId}`.
- Update `removeWorktrees` and cleanup to use the run-scoped paths.

**Acceptance:** Two pipelines can run against different repos (or the same repo) without worktree collisions.

---

## Phase 3 — Maintainability & Quality ✅

> Goal: reduce bug surface, remove dead code, and make future changes safer.

### 3.1 Add runtime validation library
**Files:** `package.json`, schema files

**Action:** Add `zod` as a dependency and use it for:
- Judge plan validation
- Config validation (replace hand-written `assertString`/`assertTool` in `config/panelists.ts`)
- HIL response validation in `src/server/server.ts`

**Acceptance:** All external JSON inputs are validated before use.

---

### 3.2 Fix TypeScript `as any` casts
**Files:** `src/agents/panel.ts`, `src/main.ts`, `src/server/telegram.ts`

**Problem:** Multiple `as any` casts weaken type safety.

**Fix:**
- Use proper `PanelistId` literals.
- Replace `event.payload as any` in Telegram with narrow helper functions or a typed event union.
- In `main.ts`, when injecting a HIL revision task, use a valid `PanelistId` array or introduce a `"hil"` source value.

**Acceptance:** `tsc --noEmit` passes with `noImplicitAny` and `strict` enabled.

---

### 3.3 Enable strict TypeScript checks
**Files:** `tsconfig.json` (create if missing)

**Action:** Add `tsconfig.json` with `strict: true`, `noImplicitAny: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.

**Acceptance:** The project compiles cleanly under strict mode.

---

### 3.4 Remove dead/unused code and dependencies
**Files:** `package.json`, `src/utils/logger.ts`, `src/main.ts`

**Action:**
- Remove `boxen` from dependencies if unused.
- Either use `src/utils/logger.ts` in `main.ts` or delete it.
- Delete committed `.DS_Store` files and add them to `.gitignore`.

**Acceptance:** No unused dependencies; no committed macOS metadata files.

---

### 3.5 Add basic test harness
**Files:** new `tests/` directory

**Action:**
- Add `bun:test` tests for:
  - `serializeCodebase` ignore/include logic
  - `extractKeyFindings` / `extractRiskLevel`
  - `loadConfig` validation
  - Worktree path generation
- Add a GitHub Actions workflow (`.github/workflows/ci.yml`) to run tests on PRs.

**Acceptance:** `bun test` passes locally and in CI.

---

### 3.6 Refactor `src/core/worktree.ts`
**Files:** `src/core/worktree.ts`

**Problem:** It mixes worktree lifecycle, file serialization, and diff utilities.

**Fix:** Split into:
- `src/core/worktree.ts` — lifecycle only
- `src/core/serializer.ts` — codebase serialization
- `src/core/diff.ts` — diff/changed-files helpers

**Acceptance:** Each module has a single, clear responsibility.

---

### 3.7 Move panelist prompts out of JSON
**Files:** `config/panelists.json`, new `config/prompts/*.md`

**Problem:** Very long prompts embedded in JSON are hard to edit and review.

**Fix:**
- Store each system prompt in a separate Markdown file.
- Load prompts at config load time and inject them into the config objects.

**Acceptance:** `panelists.json` stays readable; prompts are versioned as standalone Markdown files.

---

### 3.8 Improve file serialization strategy
**Files:** `src/core/serializer.ts`

**Problem:** Character budget is arbitrary; large repos truncate mid-file.

**Fix:**
- Prioritize files by relevance: entry points, recently changed files, config files, then others.
- Expose `maxTokensEstimate` in `config/panelists.json` per panelist.
- Truncate gracefully at file boundaries, never mid-file.

**Acceptance:** Reviewers receive the most important files first, with no mid-file truncation.

---

## Phase 4 — Optional Future Rust Migration

> Goal: define the conditions and architecture for a future port, without doing it now.

### 4.1 Migration trigger conditions
Consider porting to Rust only when **one or more** of the following are true:

1. Distribution as a single static binary is required (no Bun runtime).
2. The orchestrator must run as a long-lived daemon with crash recovery.
3. The TypeScript version is feature-stable for 3+ months.
4. Type/runtime safety becomes more valuable than iteration speed.

### 4.2 Recommended Rust architecture
If ported, use:

- **Tokio** for async runtime and process spawning.
- **serde + schemars** for JSON plan validation.
- **axum** for HTTP/WebSocket server.
- **rusqlite or sled** for run-state persistence.
- **camino** for typed file paths.
- **thiserror / anyhow** for explicit error handling.
- **tempfile + git2** for worktree management.

### 4.3 Incremental migration strategy
To avoid a big-bang rewrite:

1. **Extract core logic first:** Port `serializeCodebase`, worktree helpers, and config validation to a Rust library.
2. **Keep the TS orchestrator:** Call the Rust library via FFI or a small CLI wrapper.
3. **Replace one agent at a time:** Move panel/judge/validator logic into Rust modules once the library is solid.
4. **Final swap:** Replace `main.ts` with the Rust binary, reusing the existing `src/ui/index.html` UI.

### 4.4 What to keep in TypeScript
The browser UI (`src/ui/index.html`) can remain as-is; Rust can serve it statically. Prompts can also remain Markdown files.

---

## Added Feature: Web Config Editor

A configuration editor is now available in the browser UI:

- **Backend:** `src/server/config-api.ts` exposes `GET /api/config` and `POST /api/config`.
- **Persistence:** `config/panelists.ts` has a `saveConfig()` function that validates with Zod before writing to `config/panelists.json`.
- **Frontend:** `src/ui/index.html` has a `ConfigEditor` component reachable from the new **Config** tab in the header.
- **Tests:** `tests/config-api.test.ts` covers saving, loading, and validation.

The editor supports adding/removing panelists, editing judge/validator settings, choosing between `promptFile` and inline `systemPrompt`, and tool/model selection.

---

## Known Limitations / Not Addressed

- **Store singleton:** `src/server/store.ts` remains a global singleton. Worktrees are now scoped by `runId`, so filesystem collisions are avoided, but the UI/Telegram state only tracks one run at a time. To support true concurrent runs, inject a per-run store.
- **UI uses CDN React:** `src/ui/index.html` still loads React from a CDN. This is acceptable for local use but should be vendored or bundled before any production deployment.
- **HIL revision loop:** Revising the implementation re-runs the validator once, but does not loop back to the judge on validation failure. This matches the original behavior; add a full revision loop if needed.

---

## Suggested Execution Order

1. Phase 1 has been merged — these were safety blockers.
2. Phase 2 and Phase 3 were implemented together.
3. Leave Phase 4 as a documented decision; revisit in 3–6 months.

---

## Tracking

- Create one issue or PR per numbered item above.
- Tag Phase 1 items as `P0`, Phase 2 as `P1`, Phase 3 as `P2`, Phase 4 as `future`.
