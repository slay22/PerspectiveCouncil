import * as fs from "fs/promises";
import * as path from "path";

// ─── File Serialization ───────────────────────────────────────────────────────

const IGNORED_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".DS_Store",
  "*.pyc",
  "*.lock",
  "*.log",
];

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp",
  ".json", ".yaml", ".yml", ".toml", ".env.example",
  ".sql", ".graphql", ".proto",
  ".md", ".txt",
  "Dockerfile", "Makefile",
]);

export interface SerializeOptions {
  maxTokensEstimate?: number;
  include?: string[];
  exclude?: string[];
}

export async function serializeCodebase(
  worktreePath: string,
  options: SerializeOptions = {}
): Promise<string> {
  const maxTokensEstimate = options.maxTokensEstimate ?? 80_000;
  const charLimit = maxTokensEstimate * 4; // rough chars-per-token estimate

  const files = await collectFiles(worktreePath, options.exclude);
  const prioritized = prioritizeFiles(files, worktreePath);

  const chunks: string[] = [];
  let totalChars = 0;

  chunks.push(`# Codebase: ${path.basename(worktreePath)}\n`);
  chunks.push(`# Files: ${prioritized.length}\n\n`);

  for (const [idx, file] of prioritized.entries()) {
    if (totalChars >= charLimit) {
      chunks.push(`\n... [truncated — ${prioritized.length - idx} more files] ...\n`);
      break;
    }

    try {
      const content = await fs.readFile(file, "utf-8");
      const relPath = path.relative(worktreePath, file);
      const chunk = formatFileChunk(relPath, content);
      chunks.push(chunk);
      totalChars += chunk.length;
    } catch {
      // binary or unreadable — skip
    }
  }

  return chunks.join("");
}

function formatFileChunk(relPath: string, content: string): string {
  return `\`\`\`${getLanguage(relPath)}\n// FILE: ${relPath}\n${content}\n\`\`\`\n\n`;
}

async function collectFiles(dir: string, extraExcludes?: string[]): Promise<string[]> {
  const excludes = new Set([...IGNORED_PATTERNS, ...(extraExcludes ?? [])]);
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (shouldIgnore(entry.name, excludes)) continue;
      if (entry.isSymbolicLink()) continue; // avoid symlink loops

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && shouldInclude(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results.sort((a, b) => a.localeCompare(b));
}

function prioritizeFiles(files: string[], worktreePath: string): string[] {
  // Put entry-point/config files first so they are never truncated away.
  const entryNames = ["package.json", "tsconfig.json", "README.md", "Dockerfile", "main.ts", "index.ts"];

  return files.sort((a, b) => {
    const aRel = path.relative(worktreePath, a);
    const bRel = path.relative(worktreePath, b);
    const aEntry = entryNames.some((n) => aRel.endsWith(n));
    const bEntry = entryNames.some((n) => bRel.endsWith(n));
    if (aEntry && !bEntry) return -1;
    if (!aEntry && bEntry) return 1;
    return a.localeCompare(b);
  });
}

function shouldIgnore(name: string, patterns: Set<string>): boolean {
  for (const p of patterns) {
    if (p.startsWith("*")) {
      // Glob extension pattern, e.g. "*.lock" → match by suffix.
      if (name.endsWith(p.slice(1))) return true;
    } else if (name === p) {
      // Exact directory/file name (e.g. "node_modules", ".git").
      return true;
    }
  }
  return false;
}

function shouldInclude(name: string): boolean {
  const ext = path.extname(name);
  return (
    CODE_EXTENSIONS.has(ext) ||
    CODE_EXTENSIONS.has(name) // Dockerfile, Makefile etc
  );
}

function getLanguage(filePath: string): string {
  const base = path.basename(filePath);
  if (base === "Dockerfile") return "dockerfile";
  if (base === "Makefile") return "makefile";

  const ext = path.extname(filePath);
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx",
    ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".go": "go",
    ".rs": "rust", ".java": "java",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".sql": "sql",
    ".md": "markdown", ".graphql": "graphql",
    ".proto": "protobuf",
  };
  return map[ext] ?? "text";
}
