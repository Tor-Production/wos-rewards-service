import { Worker } from "node:worker_threads";

import { runBoundedPreflight } from "./task20-preflight-supervisor.js";

// The entire preflight runs in an isolated thread. The supervisor waits for
// termination before reporting success or failure; no Discord work can outlive it.
const worker = new Worker(new URL("./task20-preflight-worker.js", import.meta.url));
const passed = await runBoundedPreflight(worker, 28_000, 2_000, () => process.exit(1));
if (passed) {
  console.info("task20_preflight_ready");
} else {
  console.error("task20_preflight_failed");
  process.exitCode = 1;
}
