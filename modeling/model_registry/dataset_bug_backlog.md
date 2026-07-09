# Model_Review_Class1 Dataset Bug Backlog

| ID | Description | Priority |
|---|---|---|
| DQA-R1 | signal_result casing/domain mismatch | P0 |
| DQA-R2 | divergent return/PnL formula | P1 |
| DQA-R3 | created_at vs resolved_at date-mode confusion | P1 |
| DQA-R4 | duplicate market vs one physical match dedup mismatch | P1 |
| DQA-R5 | unresolved rows/fake resolved-time fallback risk | P2 |
| DQA-R6 | score null / signal_confidence fallback risk | P2 |
| DQA-R7 | formula_version vs metric_formula_version confusion | P1 |
| DQA-R8 | sport/league extraction heuristic / UNKNOWN_OR_SPORTS leakage | P1 |
| DQA-R9 | display slice misuse risk | P0 |
| DQA-R10 | script pagination/sample cap risk | P1 |
| DQA-R11 | SQL registry stubs / non-executable contracts | P1 |
| DQA-R12 | one-per-match engine writes to DB without dry-run | P1 |
| DQA-R13 | cross-version duplicate/resolution conflict risk | P2 |

## Blocked until controlled

- BLUE_MODEL2_SAFE_CORE_V2
- final PRIMARY/ALT/SHADOW/KILL selection
- live implementation prompt
