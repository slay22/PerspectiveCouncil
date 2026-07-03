import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createPR } from "../src/utils/pr.ts";
import { store } from "../src/server/store.ts";
import type {
  PipelineRun, PanelResult, JudgePlan, ValidatorReport, HILResponse,
} from "../src/core/types.ts";

// ─── Real temp git repo so createPR's push + manual fallback run against git ──

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-pr-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  // Remove any fallback body files this test wrote.
  // (Bun.write to /tmp/council-pr-<runId>.md — only one runId per test.)
});

/** Create a bare "remote" and a clone whose working tree is the worktree. */
async function makeRemoteAndWorktree(): Promise<{ remote: string; worktree: string }> {
  const remote = path.join(dir, "remote.git");
  await fs.mkdir(remote, { recursive: true });
  await run(["git","init","--bare","--initial-branch=main"], remote);

  // Seed the remote with an initial commit on main (so `push` has a ref target).
  const seed = path.join(dir, "seed");
  await fs.mkdir(seed, { recursive: true });
  await run(["git","init","--initial-branch=main"], seed);
  await run(["git","remote","add","origin",remote], seed);
  await fs.writeFile(path.join(seed, "README.md"), "# project\n", "utf-8");
  await run(["git","add","README.md"], seed);
  await run(["git","-c","user.email=t@t","-c","user.name=seed","commit","-m","init"], seed);
  await run(["git","push","-u","origin","main"], seed);

  // Clone the seed to use as the implementor's worktree.
  const worktree = path.join(dir, "impl");
  await fs.mkdir(worktree, { recursive: true });
  await run(["git","clone",remote,worktree], dir);
  // Worktree is on main; create the impl branch the push wants to push.
  await run(["git","checkout","-b","council/impl-run1"], worktree);
  await fs.writeFile(path.join(worktree, "change.txt"), "diff\n", "utf-8");
  await run(["git","add","change.txt"], worktree);
  await run(["git","-c","user.email=t@t","-c","user.name=imp","commit","-m","impl"], worktree);

  return { remote, worktree };
}

import { $ } from "bun";

// Ensure git is on PATH: the test runner's PATH may omit /opt/homebrew/bin
// (the login shell has it, the agent harness may not). The existing worktree
// tests use Bun's $ shell which honours this augmented PATH.
const GIT_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
for (const d of GIT_DIRS) {
  if (!process.env.PATH?.includes(d)) process.env.PATH = `${d}:${process.env.PATH ?? ""}`;
}

async function run(argv: string[], cwd: string): Promise<void> {
  // Use the $ shell with an array spread so each token is its own argv
  // element (a single interpolated string is treated as one command name).
  const result = await $`${argv}`.cwd(cwd).nothrow();
  if (result.exitCode !== 0) {
    const err = result.stderr.toString();
    throw new Error(`${argv.join(" ")} failed in ${cwd}: ${err.trim()}`);
  }
}

const panelResults: PanelResult[] = [
  {
    panelistId: "security", label: "Security", riskLevel: "low",
    analysis: "ok", keyFindings: ["finding A", "finding B"],
  },
] as PanelResult[];
const judgePlan: JudgePlan = {
  summary: "Fix the things. Outline of changes.",
  tasks: [
    { id: "t1", file: "change.txt", action: "create",
      instruction: "create the file", rationale: "needed",
      priority: "P0", source: ["security"] },
  ],
  riskFlags: [], outOfScope: [],
};
const validatorReport: ValidatorReport = {
  verdict: "PASS",
  taskResults: [{ taskId: "t1", verdict: "PASS", notes: "ok" }],
  outOfScopeChanges: [], notes: "done",
};
const hilResponse: HILResponse = {
  decision: "approve", reviewer: "tester", notes: undefined,
  revisePlanInstructions: undefined, reviseImplInstructions: undefined,
};

describe("createPR", () => {
  it("pushes the impl branch and uses the manual fallback when no forge CLI/token is set", async () => {
    const { worktree, remote } = await makeRemoteAndWorktree();
    const repoPath = path.join(dir, "seed"); // any path; forge=manual skips remote use

    const run: PipelineRun & Record<string, unknown> = {
      id: "run1", repoPath, branch: "main",
      stage: "pr", startedAt: new Date(), iterations: 1, maxIterations: 3,
      panelResults, judgePlan, validatorReport, hilResponse,
    } as PipelineRun & Record<string, unknown>;

    // provider: manual → forge.createPullRequest returns no url → manualFallback.
    // The push still happens (against the configured remote "origin" → the bare
    // remote we created), so we assert the branch was pushed AND a body file is
    // written with the audit trail. createPR logs to the store, so initialize it.
    store.init({
      runId: "run1", repoPath, branch: "main", projectContext: "ctx",
      maxIterations: 3,
      panelists: [{ id: "a", label: "A", icon: "🤖", model: "claude" }],
    });
    const result = await createPR(repoPath, worktree, run, {
      provider: "manual", remote: "origin",
    });

    expect(result).toBe("manual:council/impl-run1");

    // The impl branch reached the bare remote.
    const branches = await Bun.spawn({
      cmd: ["git", "ls-remote", "--heads", remote],
      stdout: "pipe", stderr: "ignore",
    });
    const out = (await new Response(branches.stdout).text()).trim();
    expect(out).toContain("refs/heads/council/impl-run1");

    // The PR body was written with the audit trail.
    const bodyPath = "/tmp/council-pr-run1.md";
    const body = await fs.readFile(bodyPath, "utf-8");
    expect(body).toContain("Perspective Council Report");
    expect(body).toContain("Security");
    expect(body).toContain("Fix the things");
    expect(body).toContain("PASS");
    await fs.unlink(bodyPath).catch(() => {});
  });

  it("throws when required pipeline data is missing", async () => {
    const { worktree } = await makeRemoteAndWorktree();
    const incomplete = {
      id: "run2", repoPath: dir, branch: "main",
      stage: "pr", startedAt: new Date(), iterations: 0, maxIterations: 3,
      // missing panelResults/judgePlan/validatorReport/hilResponse
    } as unknown as PipelineRun;
    await expect(
      createPR(dir, worktree, incomplete, { provider: "manual", remote: "origin" }),
    ).rejects.toThrow(/Missing pipeline data/);
  });
});