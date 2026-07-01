import type {
  PipelineStage,
  PanelResult,
  JudgePlan,
  PlanTask,
  ValidatorReport,
  HILResponse,
} from "../core/types.ts";

// ─── Event Types ──────────────────────────────────────────────────────────────

export type EventType =
  | "run_started"
  | "stage_changed"
  | "worktrees_ready"
  | "panelist_started"
  | "panelist_done"
  | "panel_complete"
  | "judge_started"
  | "judge_done"
  | "task_started"
  | "task_done"
  | "task_failed"
  | "impl_complete"
  | "validator_done"
  | "hil_pending"
  | "hil_received"
  | "pr_created"
  | "pipeline_done"
  | "pipeline_error"
  | "log";

export interface PipelineEvent {
  type: EventType;
  ts: number;          // Date.now()
  payload?: unknown;
}

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskState extends PlanTask {
  status: TaskStatus;
}

export interface PanelistState {
  id: string;
  label: string;
  icon: string;
  model: string;
  status: "pending" | "running" | "done" | "error";
  result?: PanelResult;
  startedAt?: number;
  doneAt?: number;
}

export interface StageEntry {
  stage: PipelineStage;
  startedAt: number;
  doneAt?: number;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

// ─── Full State Shape ─────────────────────────────────────────────────────────

export interface RunState {
  runId: string;
  repoPath: string;
  branch: string;
  projectContext: string;
  startedAt: number;

  currentStage: PipelineStage;
  stageHistory: StageEntry[];
  iteration: number;
  maxIterations: number;

  panelists: PanelistState[];
  judgePlan?: JudgePlan;
  tasks: TaskState[];
  validatorReport?: ValidatorReport;

  hilPending: boolean;
  hilResponse?: HILResponse;

  prUrl?: string;
  error?: string;

  logs: LogEntry[];
  events: PipelineEvent[];   // full event log for replay
}

// ─── Store ────────────────────────────────────────────────────────────────────

type Subscriber = (event: PipelineEvent) => void;

class StateStore {
  private state: RunState | null = null;
  private subscribers: Set<Subscriber> = new Set();
  private hilResolve: ((response: HILResponse) => void) | null = null;
  // Run-level cancel controller. Created by the conductor at run start, signalled
  // by abortCurrentRun() (POST /api/run/abort / Telegram /cancel). Threads into
  // every CLI call so an in-flight agent process is killed.
  private abortController: AbortController | null = null;

  // ── Init ───────────────────────────────────────────────────────────────────

  init(config: {
    runId: string;
    repoPath: string;
    branch: string;
    projectContext: string;
    panelists: Array<{ id: string; label: string; icon: string; model: string }>;
    maxIterations: number;
  }): void {
    this.abortController = new AbortController();
    this.state = {
      runId:          config.runId,
      repoPath:       config.repoPath,
      branch:         config.branch,
      projectContext: config.projectContext,
      startedAt:      Date.now(),
      currentStage:   "init",
      stageHistory:   [],
      iteration:      0,
      maxIterations:  config.maxIterations,
      panelists:      config.panelists.map((p) => ({
        ...p, status: "pending",
      })),
      tasks:      [],
      hilPending: false,
      logs:       [],
      events:     [],
    };
    this.emit({ type: "run_started", ts: Date.now(), payload: this.snapshot() });
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  getState(): RunState | null {
    return this.state;
  }

  /**
   * True when no run is in flight — i.e. there is no state yet, or the most
   * recent run has reached a terminal stage ("done" or "aborted"). This is the
   * single source of truth for "can a new run start?"; do NOT keep a separate
   * boolean flag in the conductor — it can drift out of sync with the store.
   */
  isIdle(): boolean {
    const s = this.state;
    if (!s) return true;
    return s.currentStage === "done" || s.currentStage === "aborted";
  }

  /**
   * The run-level abort signal. The conductor passes this to every CLI call so
   * an in-flight agent process is killed on cancellation. Returns undefined
   * when no run is active (so a stale subscriber doesn't wire up a dead signal).
   */
  abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /**
   * Cancel the in-flight run: signal every agent CLI to die, reject any pending
   * HIL gate, and mark the run aborted. No-op when nothing is running.
   */
  abortCurrentRun(): boolean {
    if (this.isIdle()) return false;
    this.abortController?.abort();
    // Releasing a pending HIL promise lets runPipeline unwind to its cleanup
    // path instead of hanging on a reviewer who may never respond.
    if (this.hilResolve) {
      this.hilResolve({ decision: "abort", reviewer: "cancel-endpoint", notes: undefined, revisePlanInstructions: undefined, reviseImplInstructions: undefined });
      this.hilResolve = null;
    }
    this.setError("Run cancelled");
    return true;
  }

  snapshot(): RunState {
    if (!this.state) throw new Error("Store not initialized");
    return structuredClone(this.state);
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  setStage(stage: PipelineStage): void {
    const s = this.require();
    const prev = s.stageHistory.at(-1);
    if (prev && !prev.doneAt) prev.doneAt = Date.now();
    s.currentStage = stage;
    s.stageHistory.push({ stage, startedAt: Date.now() });
    this.emit({ type: "stage_changed", ts: Date.now(), payload: { stage } });
  }

  setIteration(n: number): void {
    this.require().iteration = n;
  }

  panelistStarted(id: string): void {
    const p = this.getPanelist(id);
    p.status = "running";
    p.startedAt = Date.now();
    this.emit({ type: "panelist_started", ts: Date.now(), payload: { id } });
  }

  panelistDone(id: string, result: PanelResult): void {
    const p = this.getPanelist(id);
    p.status = "done";
    p.result = result;
    p.doneAt = Date.now();
    this.emit({ type: "panelist_done", ts: Date.now(), payload: { id, result } });
  }

  panelistError(id: string, error: string): void {
    const p = this.getPanelist(id);
    p.status = "error";
    p.doneAt = Date.now();
    this.emit({ type: "panelist_done", ts: Date.now(), payload: { id, error } });
    this.log("error", `Panelist ${id} failed: ${error}`);
  }

  setJudgePlan(plan: JudgePlan): void {
    const s = this.require();
    s.judgePlan = plan;
    s.tasks = plan.tasks.map((t) => ({ ...t, status: "pending" }));
    this.emit({ type: "judge_done", ts: Date.now(), payload: { plan } });
  }

  taskStarted(taskId: string): void {
    const t = this.getTask(taskId);
    if (t) t.status = "running";
    this.emit({ type: "task_started", ts: Date.now(), payload: { taskId } });
  }

  taskDone(taskId: string): void {
    const t = this.getTask(taskId);
    if (t) t.status = "done";
    this.emit({ type: "task_done", ts: Date.now(), payload: { taskId } });
  }

  taskFailed(taskId: string, error: string): void {
    const t = this.getTask(taskId);
    if (t) t.status = "failed";
    this.emit({ type: "task_failed", ts: Date.now(), payload: { taskId, error } });
    this.log("error", `Task ${taskId} failed: ${error}`);
  }

  setValidatorReport(report: ValidatorReport): void {
    this.require().validatorReport = report;
    this.emit({ type: "validator_done", ts: Date.now(), payload: { report } });
  }

  setHILPending(): void {
    this.require().hilPending = true;
    this.emit({ type: "hil_pending", ts: Date.now() });
  }

  setHILResponse(response: HILResponse): void {
    const s = this.require();
    s.hilPending = false;
    s.hilResponse = response;
    this.emit({ type: "hil_received", ts: Date.now(), payload: { response } });
    if (this.hilResolve) {
      this.hilResolve(response);
      this.hilResolve = null;
    }
  }

  setPRUrl(url: string): void {
    this.require().prUrl = url;
    this.emit({ type: "pr_created", ts: Date.now(), payload: { url } });
  }

  setDone(): void {
    const s = this.require();
    s.currentStage = "done";
    this.emit({ type: "pipeline_done", ts: Date.now() });
  }

  setError(error: string): void {
    const s = this.require();
    s.error = error;
    s.currentStage = "aborted";
    this.emit({ type: "pipeline_error", ts: Date.now(), payload: { error } });
    this.log("error", error);
  }

  log(level: LogEntry["level"], msg: string): void {
    const entry: LogEntry = { ts: Date.now(), level, msg };
    this.require().logs.push(entry);
    this.emit({ type: "log", ts: Date.now(), payload: entry });
  }

  // ── HIL Promise ────────────────────────────────────────────────────────────
  // Conductor awaits this — resolves when browser posts /api/hil

  waitForHIL(): Promise<HILResponse> {
    return new Promise((resolve) => {
      this.hilResolve = resolve;
    });
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // Public escape hatch for agents that need to emit custom events
  emit_(event: PipelineEvent): void {
    this.emit(event);
  }

  private emit(event: PipelineEvent): void {
    this.require().events.push(event);
    for (const sub of this.subscribers) {
      try { sub(event); } catch { /* don't crash the store */ }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private require(): RunState {
    if (!this.state) throw new Error("Store not initialized");
    return this.state;
  }

  private getPanelist(id: string): PanelistState {
    const p = this.require().panelists.find((p) => p.id === id);
    if (!p) throw new Error(`Panelist ${id} not found`);
    return p;
  }

  private getTask(taskId: string): TaskState | undefined {
    return this.require().tasks.find((t) => t.id === taskId);
  }
}

// Singleton
export const store = new StateStore();
