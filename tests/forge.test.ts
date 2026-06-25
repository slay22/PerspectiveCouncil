import { describe, it, expect, afterEach } from "bun:test";
import {
  parseRemoteUrl,
  defaultBaseUrl,
  slugFromRemote,
  resolveToken,
  azureWebUrl,
} from "../src/utils/forge.ts";
import { ForgeConfigSchema, CouncilConfigSchema } from "../src/core/schemas.ts";

describe("parseRemoteUrl", () => {
  it("parses https remotes", () => {
    expect(parseRemoteUrl("https://github.com/slay22/PerspectiveCouncil.git")).toEqual({
      host: "github.com",
      segments: ["slay22", "PerspectiveCouncil"],
    });
  });

  it("parses scp-style ssh remotes", () => {
    expect(parseRemoteUrl("git@gitlab.com:group/sub/project.git")).toEqual({
      host: "gitlab.com",
      segments: ["group", "sub", "project"],
    });
  });

  it("parses ssh:// remotes with a user", () => {
    expect(parseRemoteUrl("ssh://git@codeberg.org/owner/name")).toEqual({
      host: "codeberg.org",
      segments: ["owner", "name"],
    });
  });

  it("returns null for junk", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not-a-url")).toBeNull();
  });
});

describe("defaultBaseUrl", () => {
  it("uses the public API host for github.com but /api/v3 for enterprise", () => {
    expect(defaultBaseUrl("github", "github.com")).toBe("https://api.github.com");
    expect(defaultBaseUrl("github", "ghe.corp.com")).toBe("https://ghe.corp.com/api/v3");
  });

  it("defaults gitlab/gitea hosts", () => {
    expect(defaultBaseUrl("gitlab")).toBe("https://gitlab.com");
    expect(defaultBaseUrl("gitea")).toBe("https://codeberg.org");
    expect(defaultBaseUrl("gitea", "git.example.com")).toBe("https://git.example.com");
  });
});

describe("slugFromRemote", () => {
  it("joins segments for github/gitlab/gitea", () => {
    expect(slugFromRemote("github", ["owner", "name"])).toBe("owner/name");
    expect(slugFromRemote("gitlab", ["group", "sub", "project"])).toBe("group/sub/project");
  });

  it("extracts org/project/repo from an azure _git remote", () => {
    expect(slugFromRemote("azure", ["myorg", "myproject", "_git", "myrepo"])).toBe(
      "myorg/myproject/myrepo"
    );
  });
});

describe("resolveToken", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses the explicit tokenEnv when set", () => {
    process.env.MY_TOKEN = "abc";
    expect(resolveToken({ provider: "github", tokenEnv: "MY_TOKEN" })).toBe("abc");
  });

  it("falls back to provider defaults", () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "fromgh";
    expect(resolveToken({ provider: "github" })).toBe("fromgh");
  });

  it("returns undefined when nothing is set", () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GL_TOKEN;
    expect(resolveToken({ provider: "gitlab" })).toBeUndefined();
  });
});

describe("azureWebUrl", () => {
  it("builds a browsable PR url", () => {
    expect(azureWebUrl("https://dev.azure.com/org", "proj", "repo", 42)).toBe(
      "https://dev.azure.com/org/proj/_git/repo/pullrequest/42"
    );
  });
});

describe("ForgeConfig schema", () => {
  it("requires a provider and accepts optional fields", () => {
    expect(() => ForgeConfigSchema.parse({ provider: "gitlab", repo: "g/p" })).not.toThrow();
    expect(() => ForgeConfigSchema.parse({ repo: "g/p" })).toThrow();
    expect(() => ForgeConfigSchema.parse({ provider: "bitbucket" })).toThrow();
  });

  it("is optional on the council config", () => {
    const base = {
      panelists: [
        { id: "s", label: "S", tool: "claude", systemPrompt: "x" },
        { id: "q", label: "Q", tool: "pi",     systemPrompt: "x" },
      ],
      judge: { tool: "pi", label: "J", systemPrompt: "x" },
      validator: { tool: "claude", label: "V", systemPrompt: "x" },
    };
    expect(() => CouncilConfigSchema.parse(base)).not.toThrow();
    expect(() => CouncilConfigSchema.parse({ ...base, forge: { provider: "manual" } })).not.toThrow();
  });
});
