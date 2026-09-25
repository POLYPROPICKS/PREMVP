/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — IMMUTABLE RESEARCH EVIDENCE → NORMALIZED MODEL-READY VIEW.
 *
 * Pure, offline. Reads the accepted immutable D-1 research corpus
 * (`CORPUS_YYYY-MM-DD.jsonl.gz`) and the settlement-label sidecars
 * (`SETTLEMENT_LABEL_OVERLAY_YYYY-MM-DD.jsonl.gz`) from a local evidence
 * directory and emits one normalized `ModelReadyRow` per market/outcome
 * research identity. NEVER queries production. NEVER collapses identities.
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelReadyRow, ModelReadyView, TerminalStatus } from "./types";

export const DEFAULT_EVIDENCE_DIR = join(
  "modeling",
  "evidence",
  "offline-replay-plane-v1",
  "research-evidence",
);

function readJsonl(path: string): any[] {
  const buf = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function eachDay(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = new Date(fromIso + "T00:00:00Z");
  const to = new Date(toIso + "T00:00:00Z");
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function normSport(row: any): string {
  const fam = String(row.providerSportFamily ?? "").toLowerCase().trim();
  if (fam) return fam;
  const code = String(row.providerSportCode ?? row.sport ?? "").toLowerCase().trim();
  const map: Record<string, string> = {
    mlb: "baseball",
    nba: "basketball",
    wnba: "basketball",
    nhl: "hockey",
    atp: "tennis",
    wta: "tennis",
    ufc: "mma",
  };
  return map[code] ?? "unknown";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function terminalFromOverlay(o: any): TerminalStatus | null {
  if (!o) return null;
  if (o.resolutionStatus === "RESOLVED" && (o.settlementLabel === "WIN" || o.settlementLabel === "LOSS")) {
    return o.settlementLabel;
  }
  return null;
}

function terminalInline(row: any): TerminalStatus | null {
  for (const v of [row.label, row.gammaTerminal, row.cloneSignalResult]) {
    if (v === "WIN" || v === "LOSS") return v;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      if (s === "won" || s === "win") return "WIN";
      if (s === "lost" || s === "loss" || s === "lose") return "LOSS";
    }
  }
  return null;
}

export interface LoadOptions {
  evidenceDir?: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD (Sep10 is AS-OF, not a closed day — still loaded if present)
  asOf: string; // ISO instant; a settled row whose resolvedAt is after asOf is treated UNRESOLVED
}

export function loadModelReadyView(opts: LoadOptions): ModelReadyView {
  const evidenceDir = opts.evidenceDir ?? DEFAULT_EVIDENCE_DIR;
  const asOfMs = Date.parse(opts.asOf);
  const days = eachDay(opts.from, opts.to);
  const daysLoaded: string[] = [];
  const daysMissing: string[] = [];
  const labelSources: Record<string, string> = {};
  const rows: ModelReadyRow[] = [];

  for (const day of days) {
    const corpusPath = join(evidenceDir, `CORPUS_${day}.jsonl.gz`);
    if (!existsSync(corpusPath)) {
      daysMissing.push(day);
      continue;
    }
    daysLoaded.push(day);
    const corpus = readJsonl(corpusPath);

    const overlayPath = join(evidenceDir, `SETTLEMENT_LABEL_OVERLAY_${day}.jsonl.gz`);
    let overlay: Map<string, any> | null = null;
    if (existsSync(overlayPath)) {
      overlay = new Map();
      for (const o of readJsonl(overlayPath)) {
        overlay.set(
          `${String(o.conditionId ?? "").toLowerCase()}|${o.selectedTokenId ?? ""}`,
          o,
        );
      }
      labelSources[day] = "settlement_label_sidecar";
    } else {
      labelSources[day] = "corpus_inline_gammaTerminal";
    }

    // CONTRACT_A_FIELDS_OVERLAY — one-time production-materialized market_type /
    // event_start / sport / coverage for identities the compact corpus omits.
    // Only fills fields the corpus row is missing; never overrides, never synthesizes.
    const caPath = join(evidenceDir, `CONTRACT_A_FIELDS_OVERLAY_${day}.jsonl.gz`);
    let caOverlay: Map<string, any> | null = null;
    if (existsSync(caPath)) {
      caOverlay = new Map();
      for (const c of readJsonl(caPath)) caOverlay.set(c.identity, c);
    }

    for (const r of corpus) {
      const conditionId = String(r.conditionId ?? "").toLowerCase() || null;
      const tokenId = r.selectedTokenId != null ? String(r.selectedTokenId) : null;
      const identity = `${conditionId ?? ""}|${tokenId ?? ""}`;
      const physical = r.providerEventId != null ? String(r.providerEventId) : `identity:${identity}`;

      const o = overlay ? overlay.get(identity) : null;
      let terminal: TerminalStatus = "OPEN";
      let provenance = "unresolved";
      let winningOutcome: string | null = null;
      let winningToken: string | null = null;

      const overlayTerminal = terminalFromOverlay(o);
      if (overlayTerminal) {
        const resolvedAt = o?.resolvedAt ?? o?.resolved_at ?? null;
        if (resolvedAt && Number.isFinite(Date.parse(resolvedAt)) && Date.parse(resolvedAt) > asOfMs) {
          terminal = "OPEN";
          provenance = "resolved_after_as_of__held_unresolved";
        } else {
          terminal = overlayTerminal;
          provenance = `settlement_label_sidecar:${o?.settlementAuthority ?? o?.resolverState ?? "gamma_clob"}`;
          winningOutcome = o?.candidateWinningOutcome ?? null;
          winningToken = o?.candidateWinningTokenId ?? null;
        }
      } else {
        const inline = terminalInline(r);
        if (inline) {
          terminal = inline;
          provenance = "corpus_inline_gammaTerminal";
        }
      }

      const entry = num(r.entryPrice);
      const decisionAt = String(r.decisionAt ?? r.sourceCreatedAt ?? "");

      const ca = caOverlay ? caOverlay.get(identity) : null;
      const enrich: string[] = [];

      // market_type: corpus first, then overlay
      let marketType: string | null = r.marketTypeRaw ?? r.marketType ?? null;
      if (marketType == null && ca?.marketType) {
        marketType = ca.marketType;
        enrich.push("market_type");
      }

      // event_start: corpus first, then overlay
      let eventStart: string | null = r.eventStart ?? null;
      if (eventStart == null && ca?.eventStartIso) {
        eventStart = ca.eventStartIso;
        enrich.push("event_start");
      }

      // sport: corpus first, then overlay
      let sport = normSport(r);
      if (sport === "unknown" && (ca?.providerSportFamily || ca?.providerSportCode)) {
        sport = normSport({ providerSportFamily: ca.providerSportFamily, providerSportCode: ca.providerSportCode });
        if (sport !== "unknown") enrich.push("sport");
      }

      // coverage: corpus first, then overlay
      let coverage =
        num(r.dataCoverage) ?? num(r?.diagnostics?.dataCoverage) ?? num(r?.diagnostics?.coverage);
      if (coverage == null && ca?.dataCoverage != null) {
        coverage = num(ca.dataCoverage);
        if (coverage != null) enrich.push("coverage");
      }

      // lead time: recompute if we now have both endpoints
      let lead = num(r.leadTimeHours);
      if (lead == null && eventStart && decisionAt) {
        const dt = Date.parse(eventStart) - Date.parse(decisionAt);
        if (Number.isFinite(dt)) lead = dt / 3_600_000;
      }

      rows.push({
        research_identity: identity,
        // physical_event_id grouping is deliberately NOT changed by the overlay,
        // so C0/C5 economic-bet counts stay stable across the field materialization.
        physical_event_id: physical,
        provider_event_id:
          r.providerEventId != null ? String(r.providerEventId) : (ca?.providerEventId ?? null),
        condition_id: conditionId,
        selected_token_id: tokenId,
        selected_outcome: r.selectedOutcome ?? r.selected_outcome ?? null,
        sport,
        market_family: r.marketFamily ?? null,
        market_type: marketType,
        event_start: eventStart,
        decision_at: decisionAt,
        observed_as_of: r.materializedAt ?? null,
        lead_time_hours: lead,
        entry_price: entry,
        decimal_odds: entry != null && entry > 0 && entry < 1 ? 1 / entry : null,
        signal_score: num(r.scoreLevel),
        signal_score_source: r.scoreLevelSource ?? null,
        confidence: num(r.signalConfidence ?? r.signal_confidence_num),
        coverage,
        volume_usd: num(r.volumeUsd),
        liquidity_usd: num(r.liquidityUsd),
        formula_version: r.formulaVersion ?? r.metric_formula_version ?? null,
        terminal_status: terminal,
        winning_outcome: winningOutcome,
        winning_token_id: winningToken,
        gross_pnl_u_if_win: entry != null && entry > 0 && entry < 1 ? 1 / entry - 1 : null,
        gross_pnl_u_if_loss: -1,
        settlement_provenance: enrich.length ? `${provenance} | ca_fields_overlay:${enrich.join("+")}` : provenance,
        source_day: day,
      });
    }
  }

  const labeled = rows.filter((r) => r.terminal_status !== "OPEN");
  const pct = (n: number) => (rows.length ? Math.round((n / rows.length) * 10000) / 100 : 0);
  const mtN = rows.filter((r) => r.market_type != null).length;
  const esN = rows.filter((r) => r.event_start != null).length;
  const bothN = rows.filter((r) => r.market_type != null && r.event_start != null).length;
  const caEnriched = rows.filter((r) => r.settlement_provenance.includes("ca_fields_overlay")).length;
  return {
    rows,
    meta: {
      from: opts.from,
      to: opts.to,
      as_of: opts.asOf,
      evidence_dir: evidenceDir,
      days_loaded: daysLoaded,
      days_missing: daysMissing,
      label_sources: labelSources,
      counts: {
        IDENTITY_N: rows.length,
        DISTINCT_PHYSICAL_EVENT_N: new Set(rows.map((r) => r.physical_event_id)).size,
        TERMINAL_LABELED_IDENTITY_N: labeled.length,
        UNRESOLVED_IDENTITY_N: rows.length - labeled.length,
      },
      field_completeness: {
        IDENTITY_N: rows.length,
        MARKET_TYPE_PRESENT_N: mtN,
        MARKET_TYPE_PRESENT_PCT: pct(mtN),
        EVENT_START_PRESENT_N: esN,
        EVENT_START_PRESENT_PCT: pct(esN),
        BOTH_PRESENT_N: bothN,
        BOTH_PRESENT_PCT: pct(bothN),
        UNKNOWN_BOTH_MISSING_N: rows.length - rows.filter((r) => r.market_type != null || r.event_start != null).length,
        CA_FIELDS_OVERLAY_ENRICHED_N: caEnriched,
      },
    },
  };
}
