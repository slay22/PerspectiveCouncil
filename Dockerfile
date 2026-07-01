# syntax=docker/dockerfile:1
#
# Perspective Council — container image.
#
# The orchestrator shells out to git, the GitHub CLI (gh), and one or more
# agent CLIs (claude / opencode / pi). git + gh are installed below; the agent
# CLIs live in a clearly-marked block you adjust to match the tools your
# panelists.json actually uses.
#
# Build:
#   docker build -t council .
#
# Run (GUI + API reachable on the host, with a token):
#   docker run --rm -p 3000:3000 \
#     -e COUNCIL_API_TOKEN=$(openssl rand -hex 16) \
#     -e ANTHROPIC_API_KEY=... -e GH_TOKEN=... \
#     -v /path/to/target/repo:/work/repo \
#     council --repo /work/repo --branch main --context "Harden for production"
#
FROM oven/bun:1

# ── System tools: git + GitHub CLI ────────────────────────────────────────────
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Mounted target repos are usually owned by a different UID than the container
# user; tell git to trust them so `git worktree` / `git -C` don't error out.
RUN git config --system --add safe.directory '*'

# ── Agent CLIs ────────────────────────────────────────────────────────────────
# Install only the tools your panelists.json references, and pin versions for
# reproducible builds. Bun global bins land in /root/.bun/bin (added to PATH).
ENV PATH="/root/.bun/bin:${PATH}"
RUN bun add -g @anthropic-ai/claude-code
# OpenCode (used by the Quality Analyst in the default config):
#   RUN bun add -g opencode-ai
# Pi Agent (used by the Systems Designer + Judge in the default config):
#   install per its own distribution instructions, e.g. a curl installer.

# ── App ───────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# By default the GUI/API bind loopback for safety. To expose it on the network
# (`-p 3000:3000`) you MUST also set COUNCIL_API_TOKEN — the app refuses to bind
# a non-loopback host without a token. Override COUNCIL_HOST=0.0.0.0 at run time
# and pass `-e COUNCIL_API_TOKEN=...`.
ENV COUNCIL_HOST=127.0.0.1
EXPOSE 3000

# Pass --repo / --branch / --context (and optionally --config) as `docker run` args.
ENTRYPOINT ["bun", "run", "src/main.ts"]
