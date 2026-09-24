import { describe, expect, it } from "vitest";
import {
  buildOverlayRecord,
  buildPeriodStats,
  buildProviderCodeSportMap,
  countDuplicateIdentities,
  explicitSportFamily,
  reconcileSport,
  resolveMarketType,
  sortOverlay,
  type GspMarketTypeEntry,
  type OverlayRecord,
  type SourceRow,
} from "../../scripts/modeling/build-football-denominator-reconciliation";

function row(overrides: Partial<SourceRow> & { canonical_row?: Record<string, unknown> } = {}): SourceRow {
  return {
    model_date: "2026-08-05",
    population_id: "POP_A",
    condition_id: "COND_1",
    selected_token_id: "TOK_1",
    decision_at: "2026-08-05T10:00:00.000Z",
    provider_event_id: "EVT_1",
    sport_family: null,
    settlement_label: "WIN",
    entry_price_num: 0.55,
    canonical_row: {},
    ...overrides,
  };
}

describe("explicit sport carrier resolution", () => {
  it("preserves an explicit sport when all present carriers agree", () => {
    const r = row({ sport_family: "soccer", canonical_row: { sportFamily: "soccer", providerSportFamily: "SOCCER " } });
    const result = explicitSportFamily(r);
    expect(result).toEqual({ value: "soccer", conflict: false });
  });

  it("fails closed when explicit carriers materially disagree", () => {
    const r = row({ sport_family: "soccer", canonical_row: { sportFamily: "basketball" } });
    const result = explicitSportFamily(r);
    expect(result).toEqual({ value: null, conflict: true });
    const reconciled = reconcileSport(r, new Map());
    expect(reconciled.basis).toBe("SPORT_CONFLICT");
    expect(reconciled.reconciled).toBeNull();
  });
});

describe("provider-code recovery", () => {
  it("recovers sport when a provider code maps to exactly one explicit sport in the corpus", () => {
    const explicitSoccer = row({ condition_id: "C1", canonical_row: { sportFamily: "soccer", providerSportCode: "epl" } });
    const missingSport = row({ condition_id: "C2", canonical_row: { providerSportCode: "EPL" } });
    const codeMap = buildProviderCodeSportMap([explicitSoccer, missingSport]);
    const reconciled = reconcileSport(missingSport, codeMap);
    expect(reconciled.basis).toBe("SPORT_RECOVERED_PROVIDER_CODE");
    expect(reconciled.reconciled).toBe("soccer");
  });

  it("leaves an ambiguous provider code unresolved", () => {
    const soccerRow = row({ condition_id: "C1", canonical_row: { sportFamily: "soccer", providerSportCode: "amb" } });
    const basketballRow = row({ condition_id: "C2", canonical_row: { sportFamily: "basketball", providerSportCode: "amb" } });
    const missingSport = row({ condition_id: "C3", canonical_row: { providerSportCode: "amb" } });
    const codeMap = buildProviderCodeSportMap([soccerRow, basketballRow, missingSport]);
    const reconciled = reconcileSport(missingSport, codeMap);
    expect(reconciled.basis).toBe("SPORT_UNRESOLVED");
    expect(reconciled.reconciled).toBeNull();
  });
});

describe("structured market-type recovery", () => {
  it("recovers soccer from a soccer_* structured market type", () => {
    const r = row({ canonical_row: { marketTypeRaw: "soccer_exact_score" } });
    const reconciled = reconcileSport(r, new Map());
    expect(reconciled.basis).toBe("SPORT_RECOVERED_MARKET_TYPE");
    expect(reconciled.reconciled).toBe("soccer");
  });

  it("never recovers soccer from a generic cross-sport market type alone", () => {
    for (const marketTypeRaw of ["moneyline", "totals", "spreads"]) {
      const r = row({ canonical_row: { marketTypeRaw } });
      const reconciled = reconcileSport(r, new Map());
      expect(reconciled.basis).toBe("SPORT_UNRESOLVED");
      expect(reconciled.reconciled).toBeNull();
    }
  });
});

describe("market type reconciliation", () => {
  it("prefers canonical_row.marketTypeRaw and normalizes it", () => {
    const r = row({ canonical_row: { marketTypeRaw: " Moneyline " } });
    const result = resolveMarketType(r, new Map());
    expect(result).toEqual({ source: "moneyline", reconciled: "moneyline", basis: "MARKET_TYPE_CANONICAL" });
  });

  it("falls back to the latest eligible exact generated_signal_pairs match", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", decision_at: "2026-08-05T10:00:00.000Z", canonical_row: {} });
    const entries: GspMarketTypeEntry[] = [
      { id: "1", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T08:00:00.000Z", market_type: "totals" },
      { id: "2", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T09:30:00.000Z", market_type: "moneyline" },
      { id: "3", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T12:00:00.000Z", market_type: "spreads" },
    ];
    const index = new Map([["C9::T9", entries]]);
    const result = resolveMarketType(r, index);
    expect(result).toEqual({ source: "moneyline", reconciled: "moneyline", basis: "MARKET_TYPE_GSP_DIAGNOSTICS" });
  });
});

describe("optional feature availability never shrinks the denominator", () => {
  it("keeps a football row with known market/settlement even when score/volume/coverage/lead-time are missing", () => {
    const r = row({ canonical_row: { sportFamily: "soccer", marketTypeRaw: "moneyline" } });
    const overlay = buildOverlayRecord(r, new Map(), new Map());
    expect(overlay.reconciled_sport_family).toBe("soccer");
    expect(overlay.reconciled_market_type).toBe("moneyline");
    expect(overlay.settlement_available).toBe(true);
    expect(overlay.display_odds_available).toBe(true);
    expect(overlay.score_level_available).toBe(false);
    expect(overlay.volume_available).toBe(false);
    expect(overlay.data_coverage_available).toBe(false);
    expect(overlay.lead_time_available).toBe(false);

    const stats = buildPeriodStats([overlay]);
    expect(stats.canonical_soccer_physical_event_n).toBe(1);
    expect(stats.unique_physical_event_n).toBe(1);
  });
});

describe("deterministic ordering and duplicate detection", () => {
  it("sorts overlay records by the canonical identity tuple", () => {
    const a = row({ model_date: "2026-08-06", condition_id: "C2" });
    const b = row({ model_date: "2026-08-05", condition_id: "C9" });
    const c = row({ model_date: "2026-08-05", condition_id: "C1" });
    const overlay = [a, b, c].map((r) => buildOverlayRecord(r, new Map(), new Map()));
    const sorted = sortOverlay(overlay);
    expect(sorted.map((r) => `${r.model_date}|${r.condition_id}`)).toEqual([
      "2026-08-05|C1",
      "2026-08-05|C9",
      "2026-08-06|C2",
    ]);
  });

  it("reports zero duplicate identities for a unique overlay set and detects real duplicates", () => {
    const overlay: OverlayRecord[] = [
      buildOverlayRecord(row({ condition_id: "C1" }), new Map(), new Map()),
      buildOverlayRecord(row({ condition_id: "C2" }), new Map(), new Map()),
    ];
    expect(countDuplicateIdentities(overlay)).toBe(0);
    const withDup = [...overlay, overlay[0]];
    expect(countDuplicateIdentities(withDup)).toBe(1);
  });
});
