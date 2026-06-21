import { $ } from "bun";
import type { ForgeConfig, ForgeProvider } from "../core/schemas.ts";

// ─── Public types ──────────────────────────────────────────────────────────────

export interface PullRequestSpec {
  title: string;
  body: string;
  head: string;   // source branch
  base: string;   // target branch
}

export interface ForgeContext {
  repoPath: string;
  config: ForgeConfig;
}

export interface PullRequestResult {
  url: string | null;            // null → could not create; caller falls back to manual
  via: "cli" | "api" | "manual";
  detail?: string;               // human-readable note (errors, why manual)
}

export const DEFAULT_FORGE: ForgeConfig = { provider: "github", remote: "origin", cli: true };

// ─── Token resolution ──────────────────────────────────────────────────────────

const DEFAULT_TOKEN_ENVS: Record<ForgeProvider, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN", "GL_TOKEN"],
  gitea:  ["GITEA_TOKEN", "FORGEJO_TOKEN", "CODEBERG_TOKEN"],
  azure:  ["AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_PAT"],
  manual: [],
};

export function resolveToken(config: ForgeConfig): string | undefined {
  const names = config.tokenEnv ? [config.tokenEnv] : DEFAULT_TOKEN_ENVS[config.provider];
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return undefined;
}

// ─── Remote parsing & target resolution (pure) ──────────────────────────────────

export function parseRemoteUrl(url: string): { host: string; segments: string[] } | null {
  if (!url) return null;
  const s = url.trim().replace(/\.git$/, "");

  // scp-like: git@host:owner/name
  const ssh = s.match(/^[\w.+-]+@([^:]+):(.+)$/);
  if (ssh?.[1] && ssh[2]) return { host: ssh[1], segments: ssh[2].split("/").filter(Boolean) };

  // url form: scheme://[user@]host/path
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (m?.[1] && m[2]) return { host: m[1], segments: m[2].split("/").filter(Boolean) };

  return null;
}

export function defaultBaseUrl(provider: ForgeProvider, host?: string): string {
  switch (provider) {
    case "github":
      return host && host !== "github.com" ? `https://${host}/api/v3` : "https://api.github.com";
    case "gitlab":
      return `https://${host ?? "gitlab.com"}`;
    case "gitea":
      return `https://${host ?? "codeberg.org"}`;
    case "azure":
      return `https://${host ?? "dev.azure.com"}`;
    case "manual":
      return "";
  }
}

/** Derive the repo slug from a parsed remote when not given explicitly. */
export function slugFromRemote(provider: ForgeProvider, segments: string[]): string | undefined {
  if (segments.length === 0) return undefined;
  if (provider === "azure") {
    // .../{org}/{project}/_git/{repo}
    const gi = segments.indexOf("_git");
    if (gi >= 1 && segments[gi + 1]) return `${segments[0]}/${segments[gi - 1]}/${segments[gi + 1]}`;
    return undefined;
  }
  return segments.join("/");
}

interface Target {
  slug: string | undefined;   // provider-specific repo identifier
  host: string | undefined;
  baseUrl: string;
}

async function getRemoteUrl(repoPath: string, remote: string): Promise<string> {
  try {
    const r = await $`git -C ${repoPath} remote get-url ${remote}`.text();
    return r.trim();
  } catch {
    return "";
  }
}

async function resolveTarget(ctx: ForgeContext): Promise<Target> {
  const { config, repoPath } = ctx;
  const parsed = parseRemoteUrl(await getRemoteUrl(repoPath, config.remote ?? "origin"));
  const host = parsed?.host;
  const slug = config.repo ?? (parsed ? slugFromRemote(config.provider, parsed.segments) : undefined);
  const baseUrl = config.baseUrl ?? defaultBaseUrl(config.provider, host);
  return { slug, host, baseUrl };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function createPullRequest(ctx: ForgeContext, spec: PullRequestSpec): Promise<PullRequestResult> {
  const { config } = ctx;
  if (config.provider === "manual") return { url: null, via: "manual", detail: "provider is 'manual'" };

  const target = await resolveTarget(ctx);
  if (!target.slug) {
    return { url: null, via: "manual", detail: "could not determine repo slug (set forge.repo)" };
  }

  // 1) Prefer the platform CLI when allowed and present.
  if (config.cli !== false) {
    try {
      const url = await viaCli(config.provider, target, spec, ctx.repoPath);
      if (url) return { url, via: "cli" };
    } catch { /* fall through to API */ }
  }

  // 2) Fall back to the REST API when a token is available.
  const token = resolveToken(config);
  if (token) {
    try {
      const url = await viaApi(config.provider, target, spec, token);
      if (url) return { url, via: "api" };
    } catch (e) {
      return { url: null, via: "manual", detail: `API call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { url: null, via: "manual", detail: token ? "no PR created" : "no CLI available and no token set" };
}

// ─── CLI implementations ───────────────────────────────────────────────────────

async function viaCli(provider: ForgeProvider, t: Target, spec: PullRequestSpec, repoPath: string): Promise<string | null> {
  const slug = t.slug!;
  switch (provider) {
    case "github": {
      const r = await $`gh pr create --repo ${slug} --base ${spec.base} --head ${spec.head} --title ${spec.title} --body ${spec.body}`
        .cwd(repoPath).nothrow();
      return r.exitCode === 0 ? r.stdout.toString().trim() : null;
    }
    case "gitlab": {
      const r = await $`glab mr create --repo ${slug} --source-branch ${spec.head} --target-branch ${spec.base} --title ${spec.title} --description ${spec.body} --yes`
        .cwd(repoPath).nothrow();
      return r.exitCode === 0 ? firstUrl(r.stdout.toString()) : null;
    }
    case "gitea": {
      const r = await $`tea pr create --repo ${slug} --head ${spec.head} --base ${spec.base} --title ${spec.title} --description ${spec.body}`
        .cwd(repoPath).nothrow();
      return r.exitCode === 0 ? firstUrl(r.stdout.toString()) : null;
    }
    case "azure": {
      const [org, project, repository] = slug.split("/");
      if (!org || !project || !repository) return null;
      const orgUrl = `${t.baseUrl.replace(/\/$/, "")}/${org}`;
      const r = await $`az repos pr create --org ${orgUrl} --project ${project} --repository ${repository} --source-branch ${spec.head} --target-branch ${spec.base} --title ${spec.title} --description ${spec.body} --output json`
        .cwd(repoPath).nothrow();
      if (r.exitCode !== 0) return null;
      try {
        const pr = JSON.parse(r.stdout.toString());
        return azureWebUrl(orgUrl, project, repository, pr.pullRequestId);
      } catch { return null; }
    }
    case "manual":
      return null;
  }
}

// ─── REST implementations ────────────────────────────────────────────────────

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

export function azureWebUrl(orgUrl: string, project: string, repository: string, prId: number | string): string {
  return `${orgUrl.replace(/\/$/, "")}/${project}/_git/${repository}/pullrequest/${prId}`;
}

async function viaApi(provider: ForgeProvider, t: Target, spec: PullRequestSpec, token: string): Promise<string | null> {
  const slug = t.slug!;
  const base = t.baseUrl.replace(/\/$/, "");
  switch (provider) {
    case "github": {
      const pr = await postJson(
        `${base}/repos/${slug}/pulls`,
        { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        { title: spec.title, head: spec.head, base: spec.base, body: spec.body }
      );
      return pr.html_url ?? null;
    }
    case "gitlab": {
      const pr = await postJson(
        `${base}/api/v4/projects/${encodeURIComponent(slug)}/merge_requests`,
        { "PRIVATE-TOKEN": token },
        { source_branch: spec.head, target_branch: spec.base, title: spec.title, description: spec.body }
      );
      return pr.web_url ?? null;
    }
    case "gitea": {
      const [owner, name] = slug.split("/");
      if (!owner || !name) return null;
      const pr = await postJson(
        `${base}/api/v1/repos/${owner}/${name}/pulls`,
        { Authorization: `token ${token}` },
        { head: spec.head, base: spec.base, title: spec.title, body: spec.body }
      );
      return pr.html_url ?? null;
    }
    case "azure": {
      const [org, project, repository] = slug.split("/");
      if (!org || !project || !repository) return null;
      const orgUrl = `${base}/${org}`;
      const auth = Buffer.from(`:${token}`).toString("base64");
      const pr = await postJson(
        `${orgUrl}/${project}/_apis/git/repositories/${repository}/pullrequests?api-version=7.1`,
        { Authorization: `Basic ${auth}` },
        {
          sourceRefName: `refs/heads/${spec.head}`,
          targetRefName: `refs/heads/${spec.base}`,
          title: spec.title,
          description: spec.body,
        }
      );
      return pr.pullRequestId ? azureWebUrl(orgUrl, project, repository, pr.pullRequestId) : null;
    }
    case "manual":
      return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}
