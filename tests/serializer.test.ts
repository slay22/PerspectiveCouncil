import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { serializeCodebase } from "../src/core/serializer.ts";

describe("serializeCodebase", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes code files and ignores node_modules", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "node_modules", "foo"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "main.ts"), "const x = 1;\n");
    await fs.writeFile(path.join(tmpDir, "node_modules", "foo", "index.js"), "module.exports = {};");

    const out = await serializeCodebase(tmpDir);
    expect(out).toContain("main.ts");
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("node_modules");
  });

  it("respects maxTokensEstimate by truncating at file boundaries", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "a.ts"), "// a\n");
    await fs.writeFile(path.join(tmpDir, "src", "b.ts"), "// b\n");

    // Very small budget should truncate after the first file.
    const out = await serializeCodebase(tmpDir, { maxTokensEstimate: 1 });
    expect(out).toContain("[truncated");
  });

  it("ignores lock files and .DS_Store but keeps similarly-named code files", async () => {
    await fs.writeFile(path.join(tmpDir, "bun.lock"), "lockfile\n");
    await fs.writeFile(path.join(tmpDir, ".DS_Store"), "junk\n");
    // A file whose name merely starts with an ignored dir name must be kept.
    await fs.writeFile(path.join(tmpDir, "buildConfig.ts"), "export const x = 1;\n");

    const out = await serializeCodebase(tmpDir);
    expect(out).not.toContain("lockfile");
    expect(out).not.toContain("DS_Store");
    expect(out).toContain("buildConfig.ts");
  });

  it("labels a Dockerfile with the dockerfile language", async () => {
    await fs.writeFile(path.join(tmpDir, "Dockerfile"), "FROM oven/bun\n");
    const out = await serializeCodebase(tmpDir);
    expect(out).toContain("```dockerfile");
  });

  it("prioritizes entry point files", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "zzz.ts"), "// zzz\n");
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}\n");

    const out = await serializeCodebase(tmpDir);
    const pkgIndex = out.indexOf("package.json");
    const zzzIndex = out.indexOf("zzz.ts");
    expect(pkgIndex).toBeGreaterThan(-1);
    expect(zzzIndex).toBeGreaterThan(-1);
    expect(pkgIndex).toBeLessThan(zzzIndex);
  });
});
