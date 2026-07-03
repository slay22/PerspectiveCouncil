#!/usr/bin/env bun
/**
 * Generate config/panelists.schema.json from the Zod CouncilConfigSchema so the
 * two can't drift. The Zod schema (with its .refine checks) is the runtime
 * source of truth; the JSON Schema is for editor validation/autocomplete.
 *
 * Zod's .refine constraints (e.g. "systemPrompt XOR promptFile", "≥2 active
 * panelists") have no JSON Schema equivalent, so they're intentionally absent
 * here — the runtime Zod validation enforces them. This file only mirrors the
 * structural shape.
 *
 * Run via `bun run gen:schema`. `gen:schema --check` (or CI) verifies the
 * committed file is in sync.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { CouncilConfigSchema } from "../src/core/schemas.ts";

const out = path.resolve(import.meta.dir, "..", "config", "panelists.schema.json");

const jsonSchema = z.toJSONSchema(CouncilConfigSchema, { name: "CouncilConfig" });
const pretty = JSON.stringify(jsonSchema, null, 2) + "\n";

const check = process.argv.includes("--check");
const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf-8") : "";

if (check) {
  if (existing === pretty) {
    console.log("panelists.schema.json is in sync with the Zod schema.");
    process.exit(0);
  }
  console.error("panelists.schema.json is out of sync with the Zod schema.");
  console.error("Run `bun run gen:schema` and commit the result.");
  process.exit(1);
}

fs.writeFileSync(out, pretty, "utf-8");
console.log(`wrote ${out} (${pretty.length} bytes)`);