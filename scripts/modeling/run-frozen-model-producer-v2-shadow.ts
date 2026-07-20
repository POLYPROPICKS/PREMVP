// Runnable entry point for the Frozen Model Producer V2 Shadow.
// Usage:
//   npx tsx scripts/modeling/run-frozen-model-producer-v2-shadow.ts \
//     --as-of 2026-07-20T12:00:00.000Z \
//     --fixture /path/to/fixture.json \
//     --output /path/to/output.json \
//     [--limit 500]
//
// All business logic lives in lib/modeling/frozenModelProducerV2Shadow.ts
// (pure) and lib/modeling/strategies/runFrozenModelProducerV2Shadow.ts
// (thin orchestration). This file only wires the CLI.

import { runFrozenModelProducerV2Shadow } from "../../lib/modeling/strategies/runFrozenModelProducerV2Shadow";

runFrozenModelProducerV2Shadow(process.argv.slice(2))
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
