# 09_CONTEXT_DELTA_LOG.md — PolyProPicks

> This file logs significant changes since the initial context snapshot.
> Add an entry after every significant commit, schema change, or decision.
> Newest entries at top.

---

## 2026-08-04 — C1 accepted branch and configurable Planning→Reservation lock

**Git state (PROVEN):** `codex/queue-authority-cutoff-20260803` and its remote both point to
`05ed5f45f60567a80fa6a231479ae95bc92962ab` (`fix(queue): enforce Contract A authority across write fixtures`).
**Release evidence taxonomy:** C1 is not merged, deployed, or production-proven. Detailed executable
gates are freshly reverified for the release task and are recorded in its PR/release evidence rather
than this permanent context log; historical executor-result totals are not treated as immutable facts.

**Corrected orchestration model (Founder-approved target):** one sequential, operator-configured run:
model/contour and as-of cutoff → Contract A Planning → unique physical-event grouping/ranking/allocation
→ Reservation. It is not a parallel Planning job. Reservation freezes the selected portfolio; Final
Identity is limited to the reserved event; immutable Queue is Ireland's only instruction. No new Planning
table is justified now; `night_event_reservations` remains the durable handoff.

**Source gaps (PROVEN):** the current route fixes `CONTRACT_A_PLANNING_V1`, `nightWindow.ts` fixes the
17:00 anchor, and `nightEventReservations.ts` fixes 15 slots; full operator config and lineage are not
yet proven. Reservation grouping is event-level and Queue writing is downstream/separate. Failed local
Supabase observability experiments neither prove a production pipeline failure nor authorize a new
execution endpoint.

**Next value path:** C1 PR/review/merge/deploy → natural configurable Planning/Reservation run → real
Reservation→Final Identity→Queue proof → Queue-only Ireland receipt → bounded order → callback/terminal/
settlement/PnL. Docs commit is pending until the commit containing this entry is created.

---

## 2026-08-02 — NEW_COUNTUR_1_R1 architecture CORRECTION (docs only)

**Status:** `CANONICAL / FOUNDER LOCKED — R1`. Documentation only. Zero runtime, test, schema,
config, or dependency change.

**Source SHA verified against:** `6e593a5d0e66e50941f130f7792f67e487dbb347` (`origin/main`)
**Docs base commit:** `752fd87a582fadd68db6056180308801f0a045ec` (R0 package, documentation-only
ancestor diff — five files, all under `docs/ai-context/`)

Every load-bearing R0 finding was **independently re-verified from tracked source** in this
revision (`git grep` / `rg` / targeted reads / caller traces). Nothing was carried over on trust
from a prior graph-assisted review — those artifacts are Windows-only and unreachable here.

### Five corrected contradictions

1. **"Contract A runs once before Reservation" — withdrawn.** The complete final market identity
   only exists near T−90; forcing its resolution at the 17:00 planning stage produced zero
   reservations in production on 2026-07-25/26 (`lib/executor/buildFireModelCandidates.ts:2023-2030`).
   Replaced by **ONE MODEL OWNER** with two lifecycle artifacts.
2. **Rebalance defect misstated.** The deeper problem is not re-invocation but that **no fresh
   price or liquidity check exists at all** (`lib/executor/eventExecutionQueue.ts` — zero matches
   for `liquidity`/`current_price`/`orderbook`/`midpoint`), and the only guard that ever did,
   `selectBestCandidateForEventAtRebalance` (`lib/executor/nightPortfolioPlanner.ts:459`), has
   **zero callers**.
3. **"Preserves broad sports" — false on the Contract A path.** The adapter hardcodes
   `inferred_sport: "unknown"` (`buildFireModelCandidates.ts:1228`) and `strategic_scope: "OTHER"`
   (`:1230`), discarding the 15-code `MODEL_SCOPE_BY_PROVIDER_SPORT_CODE` mapping (`:652-667`)
   that already resolves real provider metadata.
4. **Identity does not survive the Queue.** `physical_event_id` and `event_start_iso` are declared
   on `NightEventReservationRow` only (`lib/executor/executorQueueTypes.ts:34-35`);
   `EventExecutionQueueRow` has neither. Additionally, `event_start_iso` is **arithmetically
   reconstructed** on the Contract A path (`buildFireModelCandidates.ts:1142-1144`) and then
   **exact-millisecond compared** against a provider-sourced Reservation value
   (`lib/executor/nightEventReservations.ts:1571-1574`).
5. **Two production execution surfaces, and a callback-key wording error.**
   `/api/executor/candidates` returns `condition_id`/`token_id`/`side`/stake behind a production
   secret with **no Reservation and no Queue row** (`app/api/executor/candidates/route.ts:204`,
   `:260`, `:308-318`), and `IRELAND_RUNTIME_CONTRACT.candidate_endpoint` still advertises it
   (`nightPortfolioPlanner.ts:157`). Separately: callback correlation is by `idempotency_key`
   (`app/api/executor/order-events/route.ts:150-166`); `executor_order_events.queue_id` **does not
   exist** (`:200-205`); the external order identifier is `clob_order_id`, never `venue_order_id`
   (which appears nowhere in tracked source).

### Corrected lifecycle

Provider inventory → observations → signal pairs / snapshots → **Contract A Planning Decision** →
event-level **Reservation** (orchestration only) → **Contract A Final Identity Decision** (bounded
to reserved events) → **mechanical execution guards** (price + liquidity refresh, stake, exposure,
time; no model, no ranking) → **immutable Queue** (sole production execution instruction) →
Ireland → callback (`idempotency_key` + exact identity cross-check, `clob_order_id` receipt) →
terminal state → balance / PnL.

Both Contract A artifacts belong to **one** model authority. They are two lifecycle stages, not
two competing model owners.

### Mermaid deleted and deferred

`docs/ai-context/NEW_COUNTUR_1.mmd` is **deleted** from the active package — it encoded the
superseded one-invocation lifecycle. It remains available in Git history at `752fd87a`. No
replacement diagram is created. Visualization is deferred until runtime implementation, a coherent
deploy, production identity proof, and broad-sports proof (Gate G27).

### Next action

**Independent Fable architecture review of the R1 package.** Allowed verdicts:
`PASS_NEW_COUNTUR_1_R1_READY_FOR_IMPLEMENTATION` or
`FAIL_NEW_COUNTUR_1_R1_WITH_EXACT_CONTRADICTION`.

**Prohibition:** no runtime implementation, schema change, merge or deploy before an R1 review
`PASS`. The cutover then remains one branch, three stacked commits (A: authoritative Contract A
decision contracts; B: Planning Decision → Reservation; C: Final Identity + mechanical guards +
Queue-only execution), one coherent review, one coherent deploy. No intermediate dual-authority
deploy.

### Active R1 documents

- [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md)
- [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md)
- [`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md)

### Still open

- [ ] Fable R1 architecture review verdict.
- [ ] Live Ireland polling URL / poller configuration — **RUNTIME-ONLY**, not provable from this
      repository, blocking pre-deploy gate (G26).
- [ ] Owner of rejection reason `MARKET_POLICY_ACTIVITY_LABEL` — still **NOT_VERIFIABLE**; zero
      matches in tracked source at `6e593a5d` (carried forward from R0).
- [ ] Classify `app/api/executor/night-plan/route.ts` and `buildFounderBattleBatchQueueRow`
      (`eventExecutionQueue.ts:1792`, called `:1903`) as production / ops-only / test-only before
      the zero-production-caller proof (G19).

---

## 2026-08-02 — NEW_COUNTUR_1 architecture package LOCKED (docs only)

**Status:** `CANONICAL / FOUNDER LOCKED` — documentation only. Zero runtime, test, schema,
config, or dependency change.

**Base production SHA:** `6e593a5d0e66e50941f130f7792f67e487dbb347`
**Production audit identifier:** `diag-probe:20260802T085311` (as-of `2026-08-02T08:53:11.000Z`)

### Proved dual-authority finding

The production contour at `6e593a5d` runs **two modelling authorities**, not one model plus
orchestration:

- `app/api/cron/night-event-reservations/route.ts:76/106/194` plans with
  `selectorMode: "CONTRACT_A_PLANNING_V1"`, but `lib/executor/buildFireModelCandidates.ts:1296`
  routes **only** `CONTRACT_A_V1` to Contract A. `CONTRACT_A_PLANNING_V1` runs the legacy CONTUR3
  pipeline and merely stamps `selector_id` / `contract_a_stage` at `:2023-2037`.
- Contract A (`lib/modeling/frozenModelProducerV2Shadow.ts`) is invoked **later, inside
  rebalance**: `lib/executor/eventExecutionQueue.ts:815` and `:1169`.
- A second ranker is live in the same layer: `compareCandidateQuality`
  (`eventExecutionQueue.ts:18`, applied `:748`).
- Therefore `Contract A output → Reservation` is **NOT WIRED**. The legacy funnel and the
  Contract A audit are parallel universes, not consecutive stages: 3228 deduped rows → 0
  candidates → 0 Reservations, versus 8049 source rows → 4 accepted decisions that reached
  nothing. The released instrumentation already refuses to chain them
  (`lib/executor/nightFunnelAudit.ts:733-745`).

### Canonical target path

Provider inventory → canonical observations → signal pairs → snapshots → **Contract A as the
sole modelling / policy / ranking owner, running once before Reservation** → versioned approved
candidate set + complete rejection trace + execution-window metadata → Reservation → mechanical-
only Rebalance → immutable Queue → Ireland → callback → terminal state → balance / PnL.

### Superseded

`CONTUR_ROADMAP_2.md` §1 two-stage modelling semantics (Stage A legacy rules at planning, Stage B
Contract A at rebalance) and §2's required repair are **superseded** by `NEW_COUNTUR_1`.
Historical documents are preserved unchanged as evidence. T−90/T−120 are Contract A input-selection
rules and execution-window metadata, never a reason to postpone the model.

### Preserves

Broad provider inventory · canonical observations · signal pairs · snapshots · broad sports and
markets · structured sport metadata · Contract A pure model logic · exact identity work ·
physical-occurrence identity · Reservation persistence · active duplicate protection · cap 15 ·
lifecycle · queue builder · Ireland mapper/API · callback · terminal states · balance/PnL ·
released funnel instrumentation as migration evidence.

### Retires from production authority

Legacy filters inside `CONTRACT_A_PLANNING_V1` · `buildFireModelCandidates` as an independent
model owner · repeated Contract A invocation inside rebalance · `compareCandidateQuality` as a
second ranker · post-Reservation policy/score/scope recalculation · unapproved market
substitution · fuzzy rediscovery. Physical deletion is a separate cleanup commit after
production parity and a zero-production-caller proof.

### Current roadmap phase and next step

Phase 10 of 13 complete (documentation package). **Next: independent Fable architecture review
of the committed package.** Allowed verdicts: `PASS_NEW_COUNTUR_1_READY_FOR_IMPLEMENTATION` or
`FAIL_NEW_COUNTUR_1_WITH_EXACT_CONTRADICTION`.

**Prohibition:** no runtime implementation before Fable `PASS`. The cutover is then one branch,
three stacked commits (A: Contract A authoritative output; B: direct output → Reservation;
C: mechanical rebalance + legacy cutoff), one coherent review, one coherent deploy. No
intermediate dual-authority deploy.

### Package artifacts

- [`NEW_COUNTUR_1.md`](./NEW_COUNTUR_1.md)
- [`NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md`](./NEW_COUNTUR_1_ARCHITECTURE_POSTMORTEM.md)
- [`NEW_COUNTUR_1_ENGINEERING_GATES.md`](./NEW_COUNTUR_1_ENGINEERING_GATES.md)
- `NEW_COUNTUR_1.mmd`

### Pending

- [ ] Fable architecture review verdict.
- [ ] Resolve the owner of rejection reason `MARKET_POLICY_ACTIVITY_LABEL` (228 rejects) — not
      locatable in tracked source at the base SHA.
- [ ] Classify `app/api/executor/night-plan/route.ts` (imports `nightPortfolioPlanner`) as
      production / ops-only / test-only before the zero-caller cutoff proof.

---

## 2026-07-04 — Work_tru_PPP04July

Stable working model checkpoint: Top Weekly restored, Latest Resolved restored, WhyTrust isolated endpoint restored with ledger + returnCurve from real preview rows. See WORK_TRU_PPP04JULY.md and WORK_TRU_PPP04JULY_FUNNEL_LOG.md.

---

## ✅ CONTUR3 — CANONICAL NIGHT EVENT RESERVATION / EXECUTION PIPELINE — 2026-06-22

**Scope:** backend executor pipeline. Public formula, scoring, landing/feed UI — НЕ изменены.

**Root cause (locked):** `/api/executor/night-plan` был stateless — каждый вызов заново
запрашивал `generated_signal_pairs`, скорил **market-level** кандидатов и применял жёсткий
`hoursToStart > 6.0` (`QUEUE_LATER_NOT_LIVE_ELIGIBLE`) как фактическое правило live-eligibility.
Не было таблицы резерваций событий, не было очереди исполнения, не было job-а ребалансировки.
Это нарушало канонический алгоритм фаундера и позволяло MLB-кандидатам опережать ожидаемый
футбольный событийный план.

**Canonical founder algorithm (LOCKED — не нарушать):**
1. ~17:00 Minsk PREMVP строит Night Portfolio Plan.
2. Операционное окно: **17:00 Minsk → 08:00 Minsk**. Горизонт планирования: следующие ~18ч.
   **Запрещено** использовать произвольный 6ч-порог как каноническое правило ночной eligibility.
3. Сначала выбираются **СОБЫТИЯ/МАТЧИ**, а не отдельные рыночные кандидаты.
4. Выбранные события замораживаются в таблицу `night_event_reservations` под `plan_run_id`.
5. Фаундеру уходит email с замороженным событийным планом.
6. Для каждого зарезервированного события за **T-60/T-30** до старта PREMVP ребалансирует:
   грузит все текущие рынки этого события → выбирает ровно ОДИН лучший рынок →
   пишет его в `event_execution_queue` (status `READY`).
7. Ireland читает **только** `event_execution_queue` через `/api/executor/queue`.
8. Ireland НЕ выбирает стратегию, НЕ ранжирует, НЕ тянет broad universe, НЕ применяет
   Tier2/Tier3 fallback, НЕ выбирает рыночную семью, НЕ переопределяет ставку,
   НЕ перезапрашивает `/api/executor/night-plan`.

**Текущая политика исполнения (LOCKED):**
- Executable real-money = **Tier1 only**. Tier2/Tier3 — только shadow.
- halftime / first-half рынки — **заблокированы** для исполнения.
- ставка выбранного рынка = **$7**.
- vault live / sub-sport routing / esports-specific policy — НЕ в этой работе.

**Новые объекты:**
- Tables: `night_event_reservations`, `event_execution_queue` (миграции append-only, не деструктивны).
- Libs: `lib/executor/nightWindow.ts`, `nightEventReservations.ts`, `eventExecutionQueue.ts`,
  `executorQueueTypes.ts`.
- Routes: `app/api/cron/night-event-reservations/route.ts`, `app/api/cron/event-rebalance/route.ts`,
  `app/api/executor/queue/route.ts`.

**`/api/executor/night-plan`** остаётся диагностическим: `planned_slots` = diagnostics only;
top-level `candidates[]` больше НЕ является исполнительным источником для Ireland (его источник —
`/api/executor/queue`). Hardcoded 6ч остаётся только как диагностический label.

**Требуется ручное действие:** миграции применяются вручную через Supabase (CI/deploy не
применяет миграции автоматически). Cron-расписание (17:00 reservation, rebalance каждые 5–10 мин)
настраивается оператором — в репозитории нет `vercel.json`/cron-конфигурации.

---

## ✅ M3-C DIRECTIONAL TOKEN MATCH FIX — 2026-06-13

**Scope:** research-only shadow diagnostics. Public formula, scoring, ranking — не изменены.

**Root cause:** Polymarket Data API trades payload возвращает id токена в поле `asset` (decimal-string), а блок M3-C читал `t.tokenId` → все exact-token matches были 0.

**Fix (2 файла):**
- `lib/feed/types.ts` — добавлен `asset?: string` в `PolymarketTrade`
- `lib/feed/buildLandingCards.ts` — M3-C exact-match фильтры переключены на `String(t.asset ?? t.tokenId ?? "").trim()`

**Что НЕ изменено:**
- Legacy aggregate фильтры (`selectedTradeCount`, `totalTradeCount`, `recentTradeCash`, `maxTradeCash`)
- `formulaVersion: trusted-initial-formula-v1.1`
- DB-схема, миграции, публичный scoring-путь

**Старые строки** в research DB не backfill-ятся (fix работает только для свежих cron-прогонов).

**Требуется:** FRESH_CRON_RUNTIME_PROOF — убедиться что `directionalFlowCoverageRatio` > 0 и `directionalFlowTokenMatchedCount` > 0 в следующем снимке.

**Exit observer / trajectory SQL:** в backlog, отдельное решение фаундера.

---

## ✅ TOP PROOF ROLLOUT COMPLETE — 2026-05-28

**HEAD:** `fe5e0de` (main, clean)

### Recent commits captured
```
fe5e0de  Repo: ignore local portrait source artifacts (.gitignore hygiene)
cca288e  Landing: improve Shark Flow portrait diversity (source.id prefix inference)
a7c73b3  Landing: add Shark Flow portrait medallions (portrait assets + CSS + picker)
3426055  Landing: unify top proof cards (cyan color language, shark headline)
5341ce0  Landing: add weekly proof card to top carousel
870f0fb  Paywall: show seven-result proof strip
c65dfba  Resolver: process newest signals first
8f2000f  Resolver: allow larger fresh scan window
```

### Feature state now in production
- **Top carousel** (max 3 slots): Shark Flow evidence card × N + Weekly Resolved Proof card (always last). Market Momentum merged into shark secondary line, not standalone card.
- **Shark Flow portrait medallion:** circular, clamp(78–90px), cyan glow/border, deterministic picker using `hashString`, sport-specific pool + multi fallback.
- **Portrait picker:** source.id prefix inference (nhl-…→nhl, wnba-…→nba, mlb-…→multi); aliases: mlb→multi, wnba→nba, mls→soccer, ncaaf→nfl, ncaab→nba; pool de-duplicated via Set; seed extended with eventTitle.
- **Portrait assets:** 24 normalized 512×512 WebP in `public/market-source-portraits/normalized/` (esport×3, multi×6, nba×2, nfl×4, nhl×2, soccer×7). Rejected: nba-03, multi-02 in quarantine. manifest.json at `public/market-source-portraits/manifest.json`.
- **Portrait diversity result:** 5 unique faces across 8 production pairs (was 2–3 before fix).
- **Weekly proof card:** real resolved data from `/api/signals/resolved`, `SignalWeekResultsCard` `top-carousel` variant, cyan color family.
- **Cron services (Railway):** `signal-resolve-cron` every 6h UTC (`0 */6 * * *`), `signal-cache-cron` every ~30 min.
- **Resolver:** processes newest signals first, wider scan window (8f2000f).

### UI accepted state (do NOT redesign unless P0 regression)
- Shark portrait medallion layout: `.sharkSourceCard` CSS class, `position:relative` on card, avatar/copy absolute relative to full card, pills absolute top-right.
- Weekly proof: large `tcReturn` + `tcReturnLabel` row, cyan pill family, chips row. Do NOT change again without founder request.
- Card height stable at `clamp(106px, 27.1vw, 124px)`.

### Next operational priority
**Daily morning GMT+3 automated ops report** — see `.claude/commands/daily-ops-report-plan.md` for spec. NOT yet implemented. Must precede audience onboarding.

### Hygiene
- `.gitignore` now ignores: raw portraits, rejected normalized, preview docs, normalize script.
- `docs/design/` remains intentionally untracked (local design reference only).

---

## ✅ WORKFLOW DECISION — 2026-05-21

**Decision:** Claude-Code Autopilot Operator Mode adopted.
**Reason:** Reduce founder CMD burden and speed execution while preserving Gate 2 for UI/visual tasks.
**Rule:** Non-visual tasks (backend/data/docs) — Claude Code may patch + verify + commit when prompt includes explicit authorization and Gate 1 passes. UI/visual tasks still require founder Gate 2 acceptance before commit. Push always requires explicit founder authorization.
**Docs updated:** CLAUDE.md §10, TASK_ROUTING_MATRIX.md §7, CLAUDE_CODE_EXECUTION_PROTOCOL.md Autopilot section, VERIFICATION_GATES.md Gate 3, OPERATOR_ACCEPTANCE_CHECKLIST.md Founder role.

---

## ✅ CURRENT STATE OVERRIDE — 2026-05-15

```
Branch:         main
HEAD:           1d254cc Score: selectedOdds banded confidence and anchored trust metrics
Origin:         synced
Working tree:   clean
```

### Recent commits (newest first)
```
1d254cc  Score: selectedOdds banded confidence and anchored trust metrics
8cabbb6  Score: opp-odds confidence cap, min threshold 52, delta multiplier 0.03
a24fbc4  Feed: two-stage odds selection 1.7x-3x primary, 1.35x-5x fallback, 72h window
c87d03c  Score: Gamma-only direct formula 35+prob*0.65, full range 35-97
ab85fd2  Context sync: HEAD 5264fd6, drift lesson #1 logged, filterTags bug noted
5264fd6  UI: constrain Mkt Return label width so Odds chip fits
a2a661c  UI: shorten Market Return label to fit tile
9109138  UI: fix Market Return layout — correct structure under CSS absolute rules
```

### Product / roadmap state
- Active gate: Decision Card visual acceptance
- Signal Confidence scoring rebuild (banded selectedOdds formula) is on main ✅
- Market Return / American odds is on main but NOT visually accepted
- Current blocker: "Odds +160" chip/label visually collides inside the Market Return tile
- Next safe patch: `app/reconstruction/page.tsx` only — simplify/remove Odds chip inside profitCol
- After visual acceptance: inspect/fix filterTags / one-card-across-filters issue
- MarketSourceCarousel evidence-stack UI: ON HOLD until Decision Card + filter sanity accepted
- Whop readiness: ON HOLD until card/feed/evidence sanity accepted

---

## ✅ CURRENT TRUTH SUMMARY (14.05.2026 ~latest) — HISTORICAL / SUPERSEDED BY CURRENT STATE OVERRIDE ABOVE

```
Backend phase:       CLOSED ✅
UI phase:            IN PROGRESS — Market Return tile + Polymarket link shipped
Enforcement contour: COMPLETE — Phase 1+2+3 done
Git HEAD:            5264fd6
Origin:              synced
Working tree:        clean
Next:                filterTags bug (one card on all filters) + MarketSourceCarousel
```

---

## Delta entry — 14.05.2026 (Market Return UI + drift lesson #1)

### UI commits — Market Return tile
```
1a8d782  UI: replace Profit tile with Market Return in American odds format
9109138  UI: fix Market Return layout — correct structure under CSS absolute rules  ← regression fix
a2a661c  UI: shorten Market Return label to fit tile
5264fd6  UI: constrain Mkt Return label width so Odds chip fits
```

### Drift lesson #1 — CSS regression
```
Cause:   Patch 1a8d782 added flex-div as first child — conflicted with CSS :first-child absolute rule
Missed:  inspect-only before CSS structure change was skipped
Fixed:   9109138
Lesson:  CSS structure changes MUST inspect active :first-child / :last-child rules before patching
Log entry: see DRIFT_MONITORING_LOG.md
```

### Known open bug
```
filterTags not distinguishing signals — one card shown on all filters
Root cause: selection logic returns same pair regardless of filter
Status: deferred until after design/carousel phase
```

### Pending
```
- [ ] filterTags bug fix
- [ ] MarketSourceCarousel evidence-stack UI (inspect-only first)
- [ ] buildSportsLandingCards.ts import graph check
- [ ] AUTOMATION_SCORECARD first scoring run
```

---

### Enforcement contour — FULLY COMMITTED ✅

All backbone artifacts committed and pushed. Phase 1+2+3 complete:
```
AUTOMATION_SCORECARD.md              3176a66
DRIFT_MONITORING_LOG.md              3176a66
VERIFICATION_GATES.md (hardened)     5101f64
OPERATOR_ACCEPTANCE_CHECKLIST.md     5101f64
CHAT_STARTER_PROMPT.md (hardened)    fd2f994
CONTEXT_HANDOFF_TEMPLATE.md (hardened) fd2f994
FAILURE_MODES_AND_STOP_CONDITIONS.md fd2f994
03_CURRENT_SOURCE_ARCHITECTURE_MAP.md (hardened) b3a5cb2
11_SOURCE_FILES_AND_REPO_INVENTORY.md (hardened) b3a5cb2
```

### UI phase — IN PROGRESS

```
eb52988  UI: add subtle Polymarket link icon in signal confidence card
a7c444e  UI: improve Polymarket link icon — green tint, larger hit area
1b36f07  UI: add see on polymarket label to link icon
```

Files modified: `app/reconstruction/page.tsx`, `Reconstruction.module.css`
Backup files created: 4× `.tsx` + 4× `.css` in `app/reconstruction/`

### League fix
```
00c5cfa  Fix league: use leagueName from discovery sample, not hardcoded sports
```

### gitignore updates
```
Added: *.txt patterns (recon-css.txt, recon-full.txt debug dumps)
```

### Pending
```
- [ ] MarketSourceCarousel evidence-stack UI — next product phase (inspect-only first)
- [ ] buildSportsLandingCards.ts import graph — NOT VERIFIED
- [ ] AUTOMATION_SCORECARD first real scoring — after 3–5 tasks through contour
```

---

## Delta entry — 14.05.2026 (backend phase CLOSED)

### Runtime verification — CONFIRMED ✓

Fresh cron run verified in Supabase at ~12:24:

| Component | Status |
|---|---|
| Fresh generation via buildLandingCards | ✅ |
| Sharp Flow in evidence stack | ✅ |
| Market Momentum in evidence stack | ✅ |
| League names (La Liga, Esports, NBA...) | ✅ |
| polymarketUrl in PremiumSignal | ✅ |
| marketSources[] in Supabase cache | ✅ |
| Cron on buildLandingCards | ✅ |
| Live matches (no futures/outrights) | ✅ |

Sample verified pairs:
```
La Liga  | https://polymarket.com/event/lal-val-ray-2026-05-14
La Liga  | https://polymarket.com/event/lal-gir-rso-2026-05-14
Esports  | https://polymarket.com/event/lol-gx-sly-2026-05-14
```

### Backend phase status: CLOSED

Next phase: MarketSourceCarousel evidence-stack UI
(per AUTOMATION_MODE_HANDOFF.md — inspect-only first in new Windsurf/Claude Code session)

---

## Delta entry — 14.05.2026

### Git commits added

```
3d1028f  Add chat starter prompt template
4e9308c  Add failure modes and stop conditions
5fc5d56  Add context handoff template
39ab5aa  Add enforcement contour backbone
26fb50d  Add gitignore for debug/cache json artifacts
af4ed5e  Cron: switch to buildLandingCards, persist marketSources in cache
5423d79  Fix league: use slug prefix map as primary source
8ba44a4  Fix league detection, add esports, add eventImage from Gamma API
```

### Enforcement contour — ADDED

New backbone artifacts committed to repo:

| File | Location | Purpose |
|---|---|---|
| `CLAUDE.md` | repo root | Primary agent entrypoint — always read first |
| `AGENTS.md` | repo root | Full agent constitution — roles, forbidden behaviors, product rules |
| `TASK_ROUTING_MATRIX.md` | docs/ai-context/ | Executor routing — CMD / Claude Code / Founder |
| `CLAUDE_CODE_EXECUTION_PROTOCOL.md` | docs/ai-context/ | Execution template + required response format |
| `VERIFICATION_GATES.md` | docs/ai-context/ | Binary gates: Gate 0–4 + Gate D + Gate 1A |
| `RULE_COMPLIANCE_MONITOR_AGENT.md` | docs/ai-context/ | Compliance audit prompt + scoring |
| `CONTEXT_HANDOFF_TEMPLATE.md` | docs/ai-context/ | Chat-to-chat state transfer template |
| `FAILURE_MODES_AND_STOP_CONDITIONS.md` | docs/ai-context/ | 25 stop conditions + recovery paths |
| `CHAT_STARTER_PROMPT.md` | docs/ai-context/ | Activation prompt for every new Claude session |

### Feed / cron changes

- `scripts/generate-signals.ts` — switched from `buildSportsLandingCards` to `buildLandingCards`
- `lib/feed/cacheGeneratedSignals.ts` — added `marketSources` field to `WritePairsInput` and insert
- Supabase: `market_sources jsonb NULL` column added to `public.generated_signal_pairs`

### Gitignore updated

Added patterns: `*.json`, `normalize-dump.txt` — covers debug/cache artifacts in repo root.

### Pending as of 14.05.2026

```
- [ ] Runtime verification: fresh generation via buildLandingCards not yet confirmed
- [ ] P0 hardening patches pending commit (CHAT_STARTER_PROMPT, CONTEXT_HANDOFF_TEMPLATE, FAILURE_MODES)
- [ ] AUTOMATION_SCORECARD.md — deferred until 3–5 real tasks completed
- [ ] DRIFT_MONITORING_LOG.md — deferred
- [ ] MarketSourceCarousel evidence-stack UI — next product task (per AUTOMATION_MODE_HANDOFF.md)
```

---

## Delta entry — 13.05.2026

### Files added to docs/ai-context/

Initial context file set committed:
`01` through `12` — project context, tech state, architecture map, product decisions,
workflow rules, lessons, migration context, environment, delta log, design system,
source inventory, startup protocol.

### Enforcement contour

Not yet created at this date. `WINDSURF_WORKFLOW_RULES.md` was the active workflow doc.
Superseded by backbone artifacts added 14.05.2026.

---

## Delta entry — 10.05.2026 (baseline snapshot)

```
Branch:   main
HEAD:     (pre-league-fix commits)
Build:    PASS
Deploy:   Railway production live at https://polypropicks.com
Feed:     buildSportsLandingCards (now superseded)
Supabase: public.generated_signal_pairs — no market_sources column yet
```

Context files created: 01–09 initial versions.

---

## How to add a new entry

When something significant changes, prepend:

```
## Delta entry — [DATE]

### [Category]
[what changed — be specific: commit hash, file, decision, schema]

### Pending
- [ ] [what is not yet verified or complete]
```

## Delta entry - 2026-06-22

### Contur2 preservation
Preserved the Contur2 producer deployment and Ireland V4 audit state in docs:
`10a2013 Executor: add night plan contract v1 envelope` deployed and runtime-verified, consumer rejector audited as present, hard-stop and no-live checks confirmed, live remains blocked pending CEO approval.

### Pending
- [ ] CEO one-order pilot checklist only

## Delta entry - 2026-07-25

### R0E canonical immutable execution identity contract
Incident `night-plan:2026-07-24:1700-minsk` (15 Reservations, 1 QUEUED, 14 SKIPPED with
`CONTRACT_A_AUTHORITATIVE_IDENTITY_INCOMPLETE`, `battle_trace_id` ending `unknown:unknown`, 0 orders)
was root-caused to two boundaries, both now corrected:

- Planning persisted no execution identity for `CONTRACT_A_PLANNING_V1` reservations, so rebalance
  tried to REDISCOVER a market from `event_slug` / `match_family_key` / source lineage.
- Planning and rebalance read different universes: planning used the broad Contur3 planning corpus,
  the final Contract A stage used the frozen-model-V2 authoritative universe.

Founder decision applied (option 1): planning is NARROWED to the authoritative execution universe;
the live-money universe was NOT broadened. New shared contract in
`lib/executor/executableMarketIdentity.ts` (`ExecutableMarketIdentityDecision`):
no complete identity -> no Reservation row; the Reservation stores the exact identity;
rebalance validates those IDs only; the queue copies them verbatim; strings never select a market
after identity creation. Persisted in the existing `diagnostics` JSONB column — no schema migration.

### Pending
- [ ] Operational: at 17:00 Minsk the authoritative universe only contains markets whose T-90
      snapshot already exists, so plan size is smaller by design. Confirm the reservation cron
      cadence (or force-rebuild schedule) fills slots as snapshots appear.
