import * as fs from "fs/promises";

// Builds the specification document fed to the panel in greenfield mode, in
// place of the serialized existing codebase.
export async function loadSpec(specPath: string | undefined, projectContext: string): Promise<string> {
  if (specPath) {
    const body = await fs.readFile(specPath, "utf-8");
    return `# Project Goal\n${projectContext}\n\n# Specification\n${body}`;
  }
  return `# Project Goal / Specification\n${projectContext}`;
}
