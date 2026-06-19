# Two-Stage Morning Pipeline Audit

Stage 1 builder: `npm run ops:morning-package`
Stage 2 sender: `npm run ops:morning-send-ready -- --send-test --email=alexgrushin@gmail.com`

Package dir: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC
Manifest: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC\manifest.json
Status: READY
strict_resolved_total: 1048
event_groups: 724
max_resolved_at: 2026-06-19T18:02:29.048Z
delta_vs_ice707_rows: 341
delta_vs_ice707_events: 223
attachment_count: 4
fire_model_status: PASS_WITH_WARNINGS
fire_model_run_id: fire_20260619_1781905023593
fire_model_run_dir: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\fire_runs\20260619_2137Z_fire_model
fire_model_primary_scope: ALL_SPORTS
fire_model_current_champion: CHAMPION_CURRENT
fire_model_best_96h_model: PUBLISHED_ONE_PER_FIXTURE
fire_model_warning_count: 3

The sender must never query generated_signal_pairs or rebuild XLSX.
