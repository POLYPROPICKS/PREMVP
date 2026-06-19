# Two-Stage Morning Pipeline Audit

Stage 1 builder: `npm run ops:morning-package`
Stage 2 sender: `npm run ops:morning-send-ready -- --send-test --email=alexgrushin@gmail.com`

Package dir: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC
Manifest: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC\manifest.json
Status: READY
strict_resolved_total: 1044
event_groups: 722
max_resolved_at: 2026-06-19T09:08:37.722Z
delta_vs_ice707_rows: 337
delta_vs_ice707_events: 221
attachment_count: 3

The sender must never query generated_signal_pairs or rebuild XLSX.
