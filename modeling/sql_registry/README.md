# FireModel SQL Registry

FireModel report calculations must reference registered `sql_id` / `query_id` contracts from this folder. The TypeScript runtime may execute equivalent Supabase REST queries when direct SQL execution is unavailable, but trusted ROI/report numbers must still trace back to these registered files and their SHA-256 hashes.

Rules:
- No ad-hoc trusted query execution.
- No DB writes.
- Every report row must trace to `model_id`, `dataset_id`, `funnel_id`, `sql_id` or `query_id`, `run_id`, and artifact path.
- SQL files are contracts and documentation; runtime adapters must preserve the same source tables, grain, and expected columns.
