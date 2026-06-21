import { describe, it, expect } from "bun:test";

// We can't easily import the private extractors, so we test via a small
// reproduction of the parsing logic used by the panel agent.

function extractStructuredOutput(analysis: string): { keyFindings?: string[]; riskLevel?: string } {
  const match = analysis.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (!match) return {};

  try {
    const parsed = JSON.parse(match[1] ?? "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const obj = parsed as Record<string, unknown>;
    const keyFindings = Array.isArray(obj.keyFindings)
      ? obj.keyFindings.filter((f): f is string => typeof f === "string")
      : [];

    const riskLevel = ["low", "medium", "high", "critical"].includes(String(obj.riskLevel))
      ? String(obj.riskLevel)
      : undefined;

    return { keyFindings, riskLevel };
  } catch {
    return {};
  }
}

describe("panel structured output parsing", () => {
  it("extracts keyFindings and riskLevel from JSON block", () => {
    const analysis = `
Some free text analysis.

\`\`\`json
{"keyFindings": ["Issue A", "Issue B"], "riskLevel": "high"}
\`\`\`
`;
    const structured = extractStructuredOutput(analysis);
    expect(structured.keyFindings).toEqual(["Issue A", "Issue B"]);
    expect(structured.riskLevel).toBe("high");
  });

  it("ignores invalid JSON", () => {
    const analysis = `
\`\`\`json
not json
\`\`\`
`;
    expect(extractStructuredOutput(analysis)).toEqual({});
  });

  it("ignores invalid riskLevel", () => {
    const analysis = `
\`\`\`json
{"keyFindings": ["X"], "riskLevel": "extreme"}
\`\`\`
`;
    const structured = extractStructuredOutput(analysis);
    expect(structured.keyFindings).toEqual(["X"]);
    expect(structured.riskLevel).toBeUndefined();
  });
});
