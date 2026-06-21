# Perspective Council — Dual-Mode "Loop Engineering" Plan

## Context

Perspective Council today is a **maintenance tool**: it analyzes an *existing* git repo
(panel reviews code → judge plans fixes → implementor edits → validator checks the diff →
HIL → PR). The user wants the same "council" concept to also do **greenfield / prototyping**
— build a *new* project from a spec — in the **same project**, with the user choosing a
**path (mode)**.

The council pipeline is mode-agnostic; only **four things** differ between modes:

| | 🔧 Maintenance (today) | 🌱 Greenfield (new) |
|---|---|---|
| Input | existing repo (`serializeCodebase`) | a spec/idea document |
| Bootstrap | use the repo | `git init` + scaffold commit |
| Agent framing | "review this code" | "design from this spec / generate files" |
| Validator signal | diff matches plan | **build/test/run works** + matches spec |

Everything else — store/event system, WebSocket UI, Telegram, CLI runner, worktree
isolation, HIL gate, forge/PR — is shared.

The backbone for *both* is a **converging loop**: today, on a validator `REJECT` the retry
re-runs the judge with **identical inputs** (`src/main.ts` iteration loop; the
`validatorReport` is never passed to `runJudge`), so it cannot actually improve. Fixing that
loop is the highest-leverage shared work and the foundation of any "build" loop.

**Decision (mode selection):** the user picks the path **explicitly**, with a **smart
inferred default** — non-empty repo → maintenance; empty dir or `--spec` given → greenfield;
always overridable via `--mode`. This keeps inputs/risk predictable per path.

The work is phased so each phase ships value on its own. Phase 1 improves the *existing*
tool immediately; Phases 2–3 add greenfield.

---

## Phase 1 — Converging feedback loop (shared, do first)

**Goal:** make the `judge → implement → validate` retry actually converge.

- `src/agents/judge.ts` — add a `validatorFeedback?` param to `runJudge` and inject a
  "## PREVIOUS ATTEMPT — VALIDATOR FINDINGS" section into the user message (the prior
  `ValidatorReport.notes` + per-task verdicts + out-of-scope changes).
- `src/main.ts` (the iteration loop, ~lines 121–157) — on `REJECT`/`PARTIAL`, pass the last
  `run.validatorReport` into the next `runJudge` call instead of re-running blind.
- **Stop criteria** in the loop: keep PASS + maxIter; add **no-progress detection** — if the
  new plan's task set is unchanged or the verdict didn't improve across an iteration, break
  early to HIL with a "stalled" log instead of burning iterations.
- `config/prompts/judge.md` — instruct the judge to prioritize addressing validator findings
  when present.

**Reuse:** existing `runJudge`/`runValidator`/store events; no new modules.
**Verify:** unit-test the no-progress/stop helper; manual run where the validator REJECTs
once and the next plan visibly references the findings.

---

## Phase 2 — Evaluation signal (shared, opt-in)

**Goal:** give the validator a concrete "does it actually work?" signal — required for
greenfield, useful for maintenance.

- New `src/core/evaluate.ts` — runs configured commands (`install` / `build` / `test` /
  optional `run` smoke) in the impl worktree, with per-command timeouts. Returns
  `{ step, ok, exitCode, output }[]`.
- `src/core/schemas.ts` — add optional `EvaluationConfigSchema` (commands, cwd, timeouts) to
  `CouncilConfigSchema`; thread through `config/panelists.ts` like `forge`.
- `src/agents/validator.ts` — accept eval results and include them in the validator prompt;
  a run that fails build/test cannot be `PASS`.
- `src/main.ts` — run `evaluate()` before/with the validate stage when configured; feed
  results into both the validator and the Phase 1 loop feedback.
- **Safety:** this executes AI-generated code, so it must be sandboxed. **Off by default**
  for maintenance (preserves today's "no shell" stance); document running it inside the
  **Docker image** as the sandbox. Surface a clear warning when enabled.
- UI Config tab + `.env.example`/README: an "Evaluation" section mirroring the forge editor.

**Reuse:** `cli-runner` timeout/abort logic; `ForgeConfig` schema/UI pattern as the template.
**Verify:** unit-test command-result parsing; run against a repo with a trivial failing test
and confirm the validator sees the failure and the loop reacts.

---

## Phase 3 — Greenfield mode

**Goal:** build a new project from a spec, reusing the now-converging loop + eval signal.

- **Mode + inputs** (`src/main.ts`): add `mode: "maintenance" | "greenfield"` and `specPath?`
  to `ConductorConfig`; make `repoPath`/`branch` optional in greenfield. `parseArgs` adds
  `--spec` and `--mode` and **infers** the default (empty/non-repo dir or `--spec` →
  greenfield). Store records the mode for the UI.
- **Bootstrap** (`src/core/worktree.ts`): new `bootstrapGreenfield(targetDir, baseBranch)` —
  `git init`, optional starter scaffold, an initial commit, and a base branch — so the
  existing `createWorktrees`/`createImplementorWorktree`/diff machinery works unchanged.
- **Panel input** (`src/agents/panel.ts`): introduce a small **source** seam — maintenance
  uses `serializeCodebase(worktreePath)` (today); greenfield uses a new `loadSpec(specPath)`.
  Same `runPanel`/`runPanelist` otherwise.
- **Implementor** (`src/agents/implementor.ts`): a greenfield variant of `buildSystemPrompt`
  that permits **creating** files (today's prompt says "only modify"; `PlanTask.action`
  already includes `"create"`). Select by mode.
- **Validator diff** (`src/core/diff.ts`): in greenfield, diff against the scaffold/initial
  commit; the real check is the Phase 2 eval signal.
- **Prompts**: greenfield variants under `config/prompts/greenfield/*.md` for
  security/quality/systems (analyze the spec/architecture); judge is largely unchanged.
  Mode selects the prompt set.
- **Mode-selection UX**: CLI (`--mode`/`--spec`); UI gets a "New Run" tab with a New-project
  vs Existing-repo toggle; Telegram a `/new` command.

**Reuse:** entire orchestrator (store, UI, Telegram, worktrees, HIL, forge), the Phase 1
loop, the Phase 2 evaluator.
**Verify:** end-to-end greenfield run from a small spec (e.g., "a Bun CLI that reverses
stdin") → produces a repo whose build/test pass → PR/initial commit; confirm maintenance
mode is unchanged (`bun test` + an existing-repo run still behave as before).

---

## Critical files (recurring touch points)

- `src/main.ts` — mode plumbing, the loop, stage wiring (all phases)
- `src/agents/{judge,validator,implementor,panel}.ts` — feedback, eval input, framing
- `src/core/{schemas,worktree,diff,cli-runner}.ts` — config, bootstrap, diff base, timeout reuse
- new: `src/core/evaluate.ts`, `src/core/loop.ts`, `src/core/spec.ts`, `config/prompts/greenfield/*.md`
- `config/panelists.ts`, `config/panelists.schema.json`, `src/ui/index.html` — config + editor
- `tests/` — loop/stop, evaluator parsing, mode inference, greenfield schema

## Suggested order

1. **Phase 1** (small, improves the current tool now).
2. **Phase 2** (medium; the one security-sensitive piece — sandbox via Docker).
3. **Phase 3** (largest; the greenfield front-end on top of the shared loop + eval).

Each phase is independently shippable; greenfield can still be split into its own tool later
(reusing the shared core as a library) if its semantics ever diverge too far.

---

## Status (as built)

All three phases plus UI/Telegram entry points are implemented and on `main`:

- Phase 1 — `src/core/loop.ts` + judge feedback + no-progress stop.
- Phase 2 — `src/core/evaluate.ts` (uses `Bun.spawn` with kill-on-timeout) + validator
  integration; off by default.
- Phase 3 — `--mode`/`--spec` + inference, `bootstrapGreenfield`/`inferMode`,
  `src/core/spec.ts` `loadSpec`, greenfield prompts, mode-aware prompt selection.
- Entry points — `POST /api/run` (+ UI "New Run" tab) and Telegram `/new`.

**Not yet done:** a real end-to-end run with the live agent CLIs (loop convergence,
greenfield producing a working project, evaluation inside Docker).
