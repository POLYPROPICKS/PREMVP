// Runnable entry point for the Frozen Execution Contract Bridge.
// Usage:
//   npx tsx scripts/modeling/run-frozen-execution-contract-bridge.ts \
//     --as-of 2026-07-20T12:00:00.000Z \
//     --fixture /path/to/fixture.json \
//     --output /path/to/output.json \
//     [--limit 5000]
//
// All business logic lives in lib/modeling/frozenExecutionContractBridge.ts
// (pure) and lib/modeling/strategies/runFrozenExecutionContractBridge.ts
// (thin orchestration). This file only wires the CLI.

import { runFrozenExecutionContractBridge } from "../../lib/modeling/strategies/runFrozenExecutionContractBridge";

runFrozenExecutionContractBridge(process.argv.slice(2))
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
