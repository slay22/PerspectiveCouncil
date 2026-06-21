#!/usr/bin/env bun
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

import { loadConfig }    from "../config/panelists.ts";
import { startServer }   from "./server/server.ts";
import { store }         from "./server/store.ts";
import { initTelegramBot, stopPolling } from "./server/telegram.ts";
import { createWorktrees, removeWorktrees, createImplementorWorktree, removeImplementorWorktree } from "./core/worktree.ts";
import { runPanel }      from "./agents/panel.ts";
import { runJudge }      from "./agents/judge.ts";
import { runImplementor } from "./agents/implementor.ts";
import { runValidator }  from "./agents/validator.ts";
import { runHIL }        from "./hil/review.ts";
import { createPR }      from "./utils/pr.ts";
import type { PipelineRun } from "./core/types.ts";

export interface ConductorConfig {
  repoPath: string;
  branch: string;
  projectContext: string;
  maxIterations?: number;
  worktreeBase?: string;
  port?: number;
  configPath?: string;        // override panelists.json location
}

let booted = false;
let pipelineActive = false;

/** True while a pipeline run is in flight. The store is a process-global
 *  singleton, so only one run may be active at a time. */
export function isPipelineActive(): boolean {
  return pipelineActive;
}

async function boot(port: number): Promise<void> {
  if (booted) return;
  booted = true;

  startServer(port);

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
  if (pipelineActive) {
    throw new Error("A pipeline run is already in progress — wait for it to finish.");
  }
  pipelineActive = true;

  const runId        = randomUUID();
  const worktreeBase = config.worktreeBase ?? os.tmpdir();
  const implPath     = path.join(worktreeBase, `council-impl-${runId}`);
  const maxIter      = config.maxIterations ?? 3;
  const port         = config.port ?? 3000;

  try {
    await boot(port);

    // ── Load config fresh from panelists.json ────────────────────────────────
    // Re-read on every pipeline run so edits take effect immediately.
    let council;
    try {
      council = loadConfig(worktreeBase, runId, config.configPath);
    } catch (e) {
      console.error("  ✗ Invalid panelists.json:", e);
      throw e;
    }

    const { panelists, judge, validator } = council;

    store.init({
      runId,
      repoPath:       config.repoPath,
      branch:         config.branch,
      projectContext: config.projectContext,
      maxIterations:  maxIter,
      panelists:      panelists.map((p) => ({
        id: p.id, label: p.label, icon: p.icon ?? "🤖", model: p.model ?? p.tool,
      })),
    });

    const run: PipelineRun = {
      id: runId, repoPath: config.repoPath, branch: config.branch,
      stage: "init", startedAt: new Date(), iterations: 0, maxIterations: maxIter,
    };

    try {
      // ── Worktrees ───────────────────────────────────────────────────────────
      store.setStage("worktrees");
      store.log("info", "Creating git worktrees…");
      await createWorktrees(config.repoPath, config.branch, panelists);
      await createImplementorWorktree(config.repoPath, config.branch, implPath, runId);
      store.emit_({ type: "worktrees_ready", ts: Date.now() });

      // ── Panel ─────────────────────────────────────────────────────────────────
      store.setStage("panel");
      const panelResults = await runPanel(panelists);
      run.panelResults = panelResults;

      // ── Plan → implement → validate → HIL loop ──────────────────────────────
      // A "revise_plan" decision loops back to the judge here (reusing the panel
      // results), rather than re-running the whole pipeline.
      let revisePlanNotes: string | undefined;

      planLoop: while (true) {
        run.iterations = 0;

        // ── Iteration loop (judge → implement → validate) ──────────────────────
        while (run.iterations < maxIter) {
          run.iterations++;
          store.setIteration(run.iterations);

          store.setStage("judge");
          run.judgePlan = await runJudge(judge, config.projectContext, panelResults, revisePlanNotes);
          revisePlanNotes = undefined; // consumed by the judge

          store.setStage("implement");
          let implError: string | null = null;
          try {
            await runImplementor(implPath, run.judgePlan);
            store.emit_({ type: "impl_complete", ts: Date.now() });
          } catch (e) {
            implError = String(e);
            store.log("error", `Implementor error: ${implError}`);
          }

          store.setStage("validate");
          run.validatorReport = await runValidator(validator, implPath, config.branch, run.judgePlan);

          if (implError) {
            // A failed/partial implementation must never auto-PR — let a human decide.
            store.log("warn", "Implementation did not complete — escalating to human review.");
            break;
          }
          if (run.validatorReport.verdict === "PASS") break;
          if (run.iterations >= maxIter) {
            store.log("warn", "Max iterations — escalating to HIL");
            break;
          }
          store.log("warn", `Validator ${run.validatorReport.verdict} — retrying…`);
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
            await runImplementor(implPath, run.judgePlan);

            // Re-validate the human-requested change before opening the PR.
            store.setStage("validate");
            run.validatorReport = await runValidator(validator, implPath, config.branch, run.judgePlan);
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
      });
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
  } finally {
    pipelineActive = false;
  }
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
  const config = parseArgs();
  await runPipeline(config);
  await new Promise(() => {}); // keep alive for Telegram + GUI
}

function parseArgs(): ConductorConfig {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`
Usage: bun run src/main.ts [options]

Options:
  --repo <path>        Path to git repository (required)
  --branch <name>      Branch to analyze (default: main)
  --context <text>     Project context (required)
  --port <n>           GUI port (default: 3000)
  --max-iter <n>       Max iterations (default: 3)
  --config <path>      panelists.json to use (default: bundled config/panelists.json)

Agent configuration:
  Edit config/panelists.json — reloaded on every run, no restart needed.
  Or pass --config <path> to use a per-project config; promptFile paths in it
  resolve relative to that file's directory.

Environment variables:
  TELEGRAM_BOT_TOKEN       From @BotFather (optional)
  TELEGRAM_ALLOWED_CHATS   Comma-separated chat IDs (optional)
  COUNCIL_HOST             Bind address for the GUI/API (default: 127.0.0.1)
  COUNCIL_API_TOKEN        Require a bearer token on config/HIL endpoints (optional)
`);
    process.exit(0);
  }

  const get = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const repo    = get("--repo");
  const context = get("--context");
  if (!repo)    { console.error("--repo is required");    process.exit(1); }
  if (!context) { console.error("--context is required"); process.exit(1); }

  const configPath = get("--config");

  return {
    repoPath:       path.resolve(repo!),
    branch:         get("--branch") ?? "main",
    projectContext: context!,
    maxIterations:  parseInt(get("--max-iter") ?? "3"),
    port:           parseInt(get("--port") ?? "3000"),
    ...(configPath ? { configPath: path.resolve(configPath) } : {}),
  };
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
