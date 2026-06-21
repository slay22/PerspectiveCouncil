import { store } from "../server/store.ts";
import type { HILResponse } from "../core/types.ts";

// HIL is now fully browser-based.
// Conductor calls this → store sets hil_pending → browser renders review UI
// → user submits → POST /api/hil → store resolves the promise → conductor continues

export async function runHIL(): Promise<HILResponse> {
  store.setHILPending();
  store.log("info", "Waiting for human review in browser…");
  const response = await store.waitForHIL();
  store.log("info", `HIL decision received: ${response.decision} by ${response.reviewer}`);
  return response;
}
