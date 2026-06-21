# Perspective Council

[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)

> Multi-agent code review and implementation orchestrator.

Three expert AI panelists analyze your codebase from isolated git worktrees. A judge synthesizes their findings into a concrete, prioritized implementation plan. Claude Code executes the plan. A validator checks that the implementation matches the plan. You review as the final human gate, and a pull request is created with a full audit trail.

---

## ✨ How it works

```
CODEBASE (read-only via git worktrees)
    │
    ├──► 🔐 Security Architect   [Claude]         ┐
    ├──► 📊 Quality Analyst      [OpenCode]       ├──► ⚖️ Judge [Pi / Kimi]
    └──► 🏗️  Systems Designer    [Pi / Kimi]      │     └──► JSON plan
                                                   │
                              ┌────────────────────┘
                              ▼
                         ⚙️  Claude Code
                         (implementor, write access)
                              │
                              ▼
                         ✅ Validator
                         (plan adherence check)
                              │
                         PASS │ REJECT (→ back to judge, max 3×)
                              │
                              ▼
                         👤 Human Review
                         (approve / revise / abort)
                              │
                              ▼
                         🚀 Pull Request
                         (with full audit trail)
```

---

## 🚀 Quick start

```bash
# 1. Install dependencies
bun install

# 2. Configure API keys and CLI tools
cp .env.example .env
# Edit .env with your keys

# 3. Run the council
bun run src/main.ts \
  --repo /path/to/your/project \
  --branch main \
  --context "Prepare this API for production. Focus on security hardening."
```

A browser UI opens automatically at `http://localhost:3000`. Use the **Config** tab to add, edit, or remove agents without touching JSON. You can also interact via Telegram if `TELEGRAM_BOT_TOKEN` is set.

To analyze a different project, point `--repo` at any git repo — the council runs from anywhere and never modifies the target's working tree (worktrees go to your temp dir). Use `--config <path>` to give a project its own `panelists.json` (its `promptFile` paths resolve relative to that file).

---

## 🐳 Docker

```bash
docker build -t council .

docker run --rm -p 3000:3000 \
  -e COUNCIL_HOST=0.0.0.0 \
  -e COUNCIL_API_TOKEN=$(openssl rand -hex 16) \
  -e ANTHROPIC_API_KEY=... -e GH_TOKEN=... \
  -v /path/to/target/repo:/work/repo \
  council --repo /work/repo --branch main --context "Harden for production"
```

Notes:
- The image installs `git` + `gh`; edit the **agent CLI** block in the `Dockerfile` to install only the tools your `panelists.json` uses (Claude Code is included by default).
- Prefer headless auth (`ANTHROPIC_API_KEY`, `GH_TOKEN`, …) over the interactive logins in the table below.
- Mount the target repo **read-write** — the implementor creates a branch in its `.git`.
- `COUNCIL_HOST=0.0.0.0` is set in the image so `-p` works; always pair it with `COUNCIL_API_TOKEN`.

---

## 📋 Requirements

- [Bun](https://bun.sh) v1.1+
- [Claude Code CLI](https://docs.anthropic.com/claude-code) installed and authenticated
- A forge CLI **or** API token for automatic PR/MR creation — optional (see [Pull requests](#-pull-requests--merge-requests))
- Git 2.5+ (for worktree support)
- API keys for the providers you configure (Anthropic, OpenAI, Moonshot, etc.)

### CLI tool configuration

Each agent uses a separate CLI tool:

| Agent | Tool | Config command |
|-------|------|----------------|
| Security Architect, Validator | Claude Code | `claude config set model claude-opus-4-5` |
| Quality Analyst | OpenCode | `opencode auth login` |
| Systems Designer, Judge | Pi Agent | `pi` → `/model` |

---

## 🧠 Agents

Agents are configured in `config/panelists.json`. Each agent has:

- `tool`: `claude`, `opencode`, or `pi`
- `model`: optional model override
- `promptFile`: path to a Markdown system prompt

```json
{
  "id": "security",
  "label": "Security Architect",
  "icon": "🔐",
  "tool": "claude",
  "model": "claude-opus-4-5",
  "promptFile": "./prompts/security.md"
}
```

Edit the Markdown prompts in `config/prompts/` and re-run — changes take effect immediately without restarting the server.

---

## 🔀 Pull requests / merge requests

The forge is configurable — GitHub, GitLab, Codeberg/Forgejo/Gitea, Azure DevOps, or `manual`. For each run the council pushes the implementation branch and then opens the PR/MR using the **platform CLI if it's installed** (`gh`/`glab`/`tea`/`az`), otherwise the **REST API** with a token. If neither is available (or `provider: "manual"`), it pushes the branch and writes the PR body to a file with manual instructions.

Configure it under a `forge` block in `config/panelists.json` (or the **Config** tab):

```json
{
  "panelists": [ /* … */ ],
  "judge": { /* … */ },
  "validator": { /* … */ },
  "forge": {
    "provider": "gitlab",
    "repo": "group/project",        // inferred from the git remote if omitted
    "baseUrl": "https://gitlab.example.com",  // optional; for self-hosted
    "tokenEnv": "GITLAB_TOKEN",     // optional; sensible default per provider
    "remote": "origin",             // optional
    "cli": true                     // optional; set false to force the API
  }
}
```

| Provider | `repo` format | CLI | Default token env |
|----------|---------------|-----|-------------------|
| `github` | `owner/name` | `gh` | `GITHUB_TOKEN` / `GH_TOKEN` |
| `gitlab` | `group/project` | `glab` | `GITLAB_TOKEN` |
| `gitea` (Codeberg/Forgejo) | `owner/name` | `tea` | `GITEA_TOKEN` / `FORGEJO_TOKEN` |
| `azure` | `org/project/repository` | `az` | `AZURE_DEVOPS_EXT_PAT` |
| `manual` | — | — | — |

Tokens are referenced by **env-var name** only — never stored in `panelists.json`.

---

## 🛡️ Human-in-the-loop review

When the validator passes, the pipeline pauses for your review in the browser UI. You can:

| Decision | What happens |
|----------|--------------|
| **Approve** | Create the PR as-is |
| **Approve with notes** | Create the PR with your notes in the description |
| **Revise plan** | Send your instructions back to the judge |
| **Revise implementation** | Send your instructions back to Claude Code |
| **Abort** | Discard all changes and clean up worktrees |

---

## 🧪 Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Watch mode
bun run dev
```

---

## 🏗️ Project structure

```
config/
  panelists.json          # Agent configuration
  panelists.schema.json   # JSON schema for config validation
  prompts/                # Markdown system prompts
src/
  agents/                 # Panel, judge, implementor, validator
  core/                   # Schemas, CLI runner, worktree, serializer, diff
  server/                 # Web UI, WebSocket, state store, Telegram bot
  utils/                  # PR creation helpers
  main.ts                 # Entry point
  ui/index.html           # Browser UI (React via CDN)
tests/                    # bun:test suite
```

---

## 🔒 Security & safety

- Each reviewer works in its own **detached, read-only git worktree**.
- The implementor works in a separate branch and worktree.
- The web server binds to **`127.0.0.1`** by default (override with `COUNCIL_HOST`). Set `COUNCIL_API_TOKEN` to require a bearer token on the config/HIL endpoints.
- LLM instructions are passed to Claude Code via `--system-prompt` files, **never through shell interpolation**.
- All external JSON inputs (judge plan, validator report, HIL response, config) are validated with **Zod**.
- CLI calls have configurable timeouts to prevent hangs.
- Worktrees and implementation branches are cleaned up on success, abort, or error.

---

## 🗺️ Roadmap

See [`PLAN.md`](./PLAN.md) for the implementation plan and a future optional Rust migration path.

---

## 🤝 Contributing

Contributions are welcome. Please make sure `bun test` and `bun run typecheck` pass before opening a PR.

---

## 📄 License

MIT
