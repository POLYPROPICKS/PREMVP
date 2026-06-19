# DB-Side Strict Corpus Morning Report Fix

## Root Cause
Morning report still read `generated_signal_pairs` directly and deduped in Node. That forced 10k-20k raw rows through Railway and caused timeout risk.

## Fix
Use a DB-side strict corpus function:
`public.get_morning_strict_resolved_corpus()`

It returns one row per `condition_id::selected_token_id` using:
`DISTINCT ON (condition_id, selected_token_id)`

Ordering:
`condition_id, selected_token_id, resolved_at desc nulls last, created_at desc nulls last, id desc`

## Expected Result
About 1045 strict rows, not 10k+ raw rows.

## Verification
Morning report should log:
`[morning-model] db-strict-corpus rows=N events=M max_resolved_at=T`

If the function is missing in DB, morning report fails with:
`DB_STRICT_CORPUS_RPC_MISSING`
