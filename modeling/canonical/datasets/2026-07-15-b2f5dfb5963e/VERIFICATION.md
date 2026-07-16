# Canonical Dataset Freeze V1 verification

The gzip member deterministically preserves the exact byte-frozen 49,400-row corpus. Query provenance is PARTIAL because the exact export cutoff and command for this snapshot were not recoverable. Historical evidence only; not a forward or live guarantee.

Verify: `node --import tsx scripts/modeling/strategies/freeze-canonical-dataset-v1.ts --verify`
