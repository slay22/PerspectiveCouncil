#!/usr/bin/env bun
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

import { loadConfig }    from "../config/panelists.ts";
import { startServer, registerPipelineRunner } from "./server/server.ts";
import { store }         from "./server/store.ts";
import { initTelegramBot, stopPolling } from "./server/telegram.ts";
import { createWorktrees, removeWorktrees, createImplementorWorktree, removeImplementorWorktree, inferMode, bootstrapGreenfield } from "./core/worktree.ts";
import { loadSpec } from "./core/spec.ts";
import { runPanel }      from "./agents/panel.ts";
import { runJudge }      from "./agents/judge.ts";
import { runImplementor } from "./agents/implementor.ts";
import { runValidator }  from "./agents/validator.ts";
import { runHIL }        from "./hil/review.ts";
import { createPR }      from "./utils/pr.ts";
import { planSignature, isStalled, formatValidatorFeedback } from "./core/loop.ts";
import { runEvaluation } from "./core/evaluate.ts";
import type { PipelineRun, ValidatorVerdict, PipelineMode } from "./core/types.ts";

export interface ConductorConfig {
  repoPath: string;
  branch: string;
  projectContext: string;
  maxIterations?: number;
  worktreeBase?: string;
  port?: number;
  configPath?: string;        // override panelists.json location
  mode?: PipelineMode;        // explicit override; inferred when omitted
  specPath?: string;          // greenfield: path to a spec document
}

let booted = false;

async function boot(port: number): Promise<void> {
  if (booted) return;
  booted = true;

  startServer(port);
  registerPipelineRunner(runPipeline);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token) {
    const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHATS ?? "")
      .split(",").map((s) => parseInt(s.trim())).filter(Boolean);
    await initTelegramBot({ token, allowedChatIds, onRun: runPipeline })
      .catch((e) => console.warn("  ⚠ Telegram not started:", e));
  } else {
    console.log("  ℹ TELEGRAM_BOT_TOKEN not set — Telegram disabled\n");
  }

  process.on("SIGINT",  () => { stopPolling(); process.exit(0); });
  process.on("SIGTERM", () => { stopPolling(); process.exit(0); });
}

export async function runPipeline(config: ConductorConfig): Promise<void> {
  // The store is a process-global singleton; reject overlapping runs so a
  // second /run (or a stray call) can't reset the in-flight run's state.
  // store.isIdle() is the single source of truth for "can a run start?".
  if (!store.isIdle()) {
    throw new Error("A pipeline run is already in progress — wait for it to finish.");
  }

  const runId        = randomUUID();
  const worktreeBase = config.worktreeBase ?? os.tmpdir();
  const implPath     = path.join(worktreeBase, `council-impl-${runId}`);
  const maxIter      = config.maxIterations ?? 3;
  const port         = config.port ?? 3000;

  await boot(port);

  // ── Resolve mode (explicit override, else --spec, else infer from repo) ───
  const mode: PipelineMode =
    config.mode ?? (config.specPath ? "greenfield" : await inferMode(config.repoPath));

  // ── Load config fresh from panelists.json ────────────────────────────────
  // Re-read on every pipeline run so edits take effect immediately.
  let council;
  try {
    council = loadConfig(worktreeBase, runId, config.configPath, mode);
  } catch (e) {
    console.error("  ✗ Invalid panelists.json:", e);
    throw e;
  }

  const { panelists, judge, validator, forge, evaluation } = council;

  // Filter out inactive panelists. Inactive ones are kept in
  // config/panelists.json so the user can re-enable them, but they
  // don't get a worktree, don't run, and don't show in the live UI.
  // The cast is needed because CouncilConfig's Zod-inferred PanelistConfig
  // and the runtime PanelistConfig (with worktreePath) are distinct types.
  const activePanelists = panelists.filter((p) => p.active !== false) as Array<typeof panelists[number]>;
  for (const p of panelists) {
    if (p.active === false) {
      store.log("info", `Skipping inactive panelist: ${p.label} (${p.id})`);
    }
  }

  store.init({
    runId,
    repoPath:       config.repoPath,
    branch:         config.branch,
    projectContext: config.projectContext,
    maxIterations:  maxIter,
    panelists:      activePanelists.map((p) => ({
      id: p.id, label: p.label, icon: p.icon ?? "🤖", model: p.model ?? p.tool,
    })),
  });

  store.log("info", `Mode: ${mode}`);
  if (evaluation?.enabled) {
    store.log("warn", "Evaluation enabled — build/test/run commands will execute agent-generated code. Use the Docker sandbox.");
  }

  const run: PipelineRun = {
    id: runId, repoPath: config.repoPath, branch: config.branch,
    stage: "init", startedAt: new Date(), iterations: 0, maxIterations: maxIter,
  };

  try {
    // ── Worktrees ───────────────────────────────────────────────────────────
    store.setStage("worktrees");
    if (mode === "greenfield") {
      store.log("info", "Bootstrapping new project…");
      await bootstrapGreenfield(config.repoPath, config.branch);
    }
    store.log("info", "Creating git worktrees…");
    await createWorktrees(config.repoPath, config.branch, activePanelists);
    await createImplementorWorktree(config.repoPath, config.branch, implPath, runId);
    store.emit_({ type: "worktrees_ready", ts: Date.now() });

    // ── Panel ─────────────────────────────────────────────────────────────────
    store.setStage("panel");
    const specText = mode === "greenfield"
      ? await loadSpec(config.specPath, config.projectContext)
      : undefined;
    const panelResults = await runPanel(activePanelists, { specText });
    run.panelResults = panelResults;

    // ── Plan → implement → validate → HIL loop ──────────────────────────────
    // A "revise_plan" decision loops back to the judge here (reusing the panel
    // results), rather than re-running the whole pipeline.
    let revisePlanNotes: string | undefined;

    planLoop: while (true) {
      run.iterations = 0;

      // Feedback carried across iterations so retries actually converge.
      let validatorFeedback: string | undefined;
      let prevPlanSig: string | undefined;
      let prevVerdict: ValidatorVerdict | undefined;

      // ── Iteration loop (judge → implement → validate) ──────────────────────
      while (run.iterations < maxIter) {
        run.iterations++;
        store.setIteration(run.iterations);

        store.setStage("judge");
        run.judgePlan = await runJudge(judge, config.projectContext, panelResults, revisePlanNotes, validatorFeedback);
        revisePlanNotes = undefined; // consumed by the judge
        const currPlanSig = planSignature(run.judgePlan);

        store.setStage("implement");
        let implError: string | null = null;
        try {
          await runImplementor(implPath, run.judgePlan, mode);
          store.emit_({ type: "impl_complete", ts: Date.now() });
        } catch (e) {
          implError = String(e);
          store.log("error", `Implementor error: ${implError}`);
        }

        store.setStage("validate");
        let evalResult;
        if (evaluation?.enabled) {
          store.log("info", "Running evaluation (build/test)…");
          evalResult = await runEvaluation(implPath, evaluation);
          store.log(evalResult.passed ? "info" : "warn", `Evaluation ${evalResult.passed ? "passed" : "failed"}.`);
        }
        run.validatorReport = await runValidator(validator, implPath, config.branch, run.judgePlan, evalResult);
        const currVerdict = run.validatorReport.verdict;

        if (implError) {
          // A failed/partial implementation must never auto-PR — let a human decide.
          store.log("warn", "Implementation did not complete — escalating to human review.");
          break;
        }
        if (currVerdict === "PASS") break;
        if (run.iterations >= maxIter) {
          store.log("warn", "Max iterations — escalating to HIL");
          break;
        }
        if (isStalled({ prevPlanSig, currPlanSig, prevVerdict, currVerdict })) {
          store.log("warn", "No progress (same plan, no improvement) — escalating to HIL");
          break;
        }

        // Feed this iteration's findings into the next judge call.
        validatorFeedback = formatValidatorFeedback(run.validatorReport);
        prevPlanSig = currPlanSig;
        prevVerdict = currVerdict;
        store.log("warn", `Validator ${currVerdict} — retrying with feedback…`);
      }

      // ── HIL ──────────────────────────────────────────────────────────────────
      store.setStage("hil");
      await runHIL();
      run.hilResponse = store.getState()!.hilResponse!;

      if (run.hilResponse.decision === "abort") {
        store.setStage("aborted");
        store.log("info", "Aborted by reviewer.");
        await cleanup(config.repoPath, panelists, implPath);
        return;
      }

      if (run.hilResponse.decision === "revise_plan") {
        store.log("info", "Returning to judge with reviewer notes…");
        revisePlanNotes = run.hilResponse.revisePlanInstructions;
        continue planLoop; // reuse panel results, re-run the judge
      }

      if (run.hilResponse.decision === "revise_implementation") {
        store.log("info", "Revising implementation…");
        if (run.judgePlan && run.hilResponse.reviseImplInstructions) {
          run.judgePlan.tasks.push({
            id: `hil-${Date.now()}`, file: ".", action: "refactor",
            instruction: run.hilResponse.reviseImplInstructions,
            rationale: "Human reviewer requested", priority: "P0", source: ["hil"],
          });
          await runImplementor(implPath, run.judgePlan, mode);

          // Re-validate the human-requested change before opening the PR.
          store.setStage("validate");
          const reEval = evaluation?.enabled ? await runEvaluation(implPath, evaluation) : undefined;
          run.validatorReport = await runValidator(validator, implPath, config.branch, run.judgePlan, reEval);
          if (run.validatorReport.verdict === "REJECT") {
            store.log("warn", "HIL revision failed validation — proceeding to PR anyway.");
          }
        }
      }

      break; // approve / approve_with_notes / revise_implementation → proceed to PR
    }

    // ── PR ────────────────────────────────────────────────────────────────────
    store.setStage("pr");
    store.log("info", "Creating pull request…");
    const prUrl = await createPR(config.repoPath, implPath, {
      ...run,
      panelResults:    run.panelResults,
      judgePlan:       run.judgePlan,
      validatorReport: run.validatorReport,
      hilResponse:     run.hilResponse,
    }, forge);
    store.setPRUrl(prUrl);
    store.setDone();
    store.log("info", `PR created: ${prUrl}`);

    // Clean up implementation worktree now that the branch has been pushed
    await cleanup(config.repoPath, panelists, implPath);

  } catch (e) {
    store.setError(String(e));
    await cleanup(config.repoPath, panelists, implPath);
    throw e;
  }
  // No finally flag to clear: store.isIdle() (currentStage done/aborted) is
  // the single source of truth that re-enables a new run.
}

async function cleanup(
  repoPath: string,
  panelists: ReturnType<typeof loadConfig>["panelists"],
  implPath: string
): Promise<void> {
  try { await removeWorktrees(repoPath, panelists); }
  catch (e) { console.warn("  ⚠ Failed to remove panelist worktrees:", e); }
  try { await removeImplementorWorktree(repoPath, implPath); }
  catch (e) { console.warn("  ⚠ Failed to remove implementor worktree:", e); }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs();
  if (parsed.configOnly) {
    await boot(parsed.port);
    console.log("  ℹ --config-only: GUI up. Use the New Run tab or POST /api/run to start a pipeline.");
    await new Promise(() => {}); // keep alive for Telegram + GUI
    return;
  }
  const { configOnly: _ignored, ...config } = parsed;
  await runPipeline(config);
  await new Promise(() => {}); // keep alive for Telegram + GUI
}

type CliResult = { configOnly: true; port: number } | ({ configOnly: false } & ConductorConfig);

function parseArgs(): CliResult {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`
Usage: bun run src/main.ts [options]

Options:
  --repo <path>        Target directory: existing repo (maintenance) or where to
                       create a new project (greenfield) (required unless --config-only)
  --branch <name>      Branch to analyze / build on (default: main)
  --context <text>     Project goal (maintenance) or the idea/spec (greenfield) (required unless --config-only)
  --mode <m>           maintenance | greenfield (inferred from --repo/--spec if omitted)
  --spec <path>        Greenfield: path to a specification document (implies greenfield)
  --port <n>           GUI port (default: 3000, or $COUNCIL_PORT)
  --max-iter <n>       Max iterations (default: 3)
  --config <path>      panelists.json to use (default: bundled config/panelists.json)
  --config-only        Boot the GUI + Telegram without running a pipeline. Use the
                       New Run tab (or POST /api/run) to start a run later.

Modes:
  maintenance — analyze an existing repo and propose/implement fixes (default for a repo)
  greenfield  — build a new project from --context/--spec (default for an empty dir)

Agent configuration:
  Edit config/panelists.json — reloaded on every run, no restart needed.
  Or pass --config <path> to use a per-project config; promptFile paths in it
  resolve relative to that file's directory.

Environment variables:
  TELEGRAM_BOT_TOKEN       From @BotFather (optional)
  TELEGRAM_ALLOWED_CHATS   Comma-separated chat IDs (optional)
  COUNCIL_HOST             Bind address for the GUI/API (default: 127.0.0.1)
  COUNCIL_PORT             GUI port when --port is not given (default: 3000)
  COUNCIL_API_TOKEN        Require a bearer token on config/HIL endpoints (optional)
`);
    process.exit(0);
  }

  const get = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const configOnly = args.includes("--config-only");
  const portArg    = get("--port") ?? process.env.COUNCIL_PORT;
  const port       = parseInt(portArg ?? "3000");
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error(`--port must be a number 1-65535 (got: ${portArg})`);
    process.exit(1);
  }
  if (configOnly) {
    return { configOnly: true, port };
  }

  const repo    = get("--repo");
  const context = get("--context");
  if (!repo)    { console.error("--repo is required");    process.exit(1); }
  if (!context) { console.error("--context is required"); process.exit(1); }

  const configPath = get("--config");
  const specPath   = get("--spec");
  const modeArg    = get("--mode");
  if (modeArg && modeArg !== "maintenance" && modeArg !== "greenfield") {
    console.error("--mode must be 'maintenance' or 'greenfield'"); process.exit(1);
  }

  return {
    configOnly: false,
    repoPath:       path.resolve(repo!),
    branch:         get("--branch") ?? "main",
    projectContext: context!,
    maxIterations:  parseInt(get("--max-iter") ?? "3"),
    port,
    ...(configPath ? { configPath: path.resolve(configPath) } : {}),
    ...(specPath   ? { specPath:   path.resolve(specPath) }   : {}),
    ...(modeArg    ? { mode: modeArg as PipelineMode }        : {}),
  };
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
