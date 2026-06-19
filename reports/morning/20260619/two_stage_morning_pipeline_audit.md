# Two-Stage Morning Pipeline Audit

Stage 1 builder: `npm run ops:morning-package`
Stage 2 sender: `npm run ops:morning-send-ready -- --send-test --email=alexgrushin@gmail.com`

Package dir: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC
Manifest: C:\WORK\KalshiProPulse\sipropicks-premvp1-1\modeling\morning_model_report\20260619_0600UTC\manifest.json
Status: READY
strict_resolved_total: 1045
event_groups: 723
max_resolved_at: 2026-06-19T09:14:28.698Z
delta_vs_ice707_rows: 338
delta_vs_ice707_events: 222
attachment_count: 3

The sender must never query generated_signal_pairs or rebuild XLSX.
