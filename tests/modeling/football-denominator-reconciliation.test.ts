import { describe, expect, it } from "vitest";
import {
  marketTypeLineageBreakdown,
  readPartitionedSourceDate,
} from "../../scripts/modeling/build-football-denominator-reconciliation-v2";
import {
  buildOverlayRecord,
  buildPeriodStats,
  buildProviderCodeSportMap,
  countDuplicateIdentities,
  explicitSportFamily,
  MarketTypeResolverIndex,
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

describe("bounded denominator source partitions", () => {
  const sourceRow = (population_id: string, condition_id: string): SourceRow => ({
    model_date: "2026-08-04",
    population_id,
    condition_id,
    selected_token_id: "TOKEN",
    decision_at: "2026-08-04T00:00:00.000Z",
    provider_event_id: null,
    sport_family: null,
    settlement_label: null,
    entry_price_num: null,
    canonical_row: {},
  });

  it("merges first-level buckets and returns deterministic identity order", async () => {
    const calls: string[] = [];
    const result = await readPartitionedSourceDate("2026-08-04", async (prefix) => {
      calls.push(prefix);
      if (prefix === "0x0") return [sourceRow("POP_B", "0x01")];
      if (prefix === "0x1") return [sourceRow("POP_A", "0x10")];
      return [];
    }, 3);
    expect(calls).toHaveLength(16);
    expect(result.map((item) => item.population_id)).toEqual(["POP_A", "POP_B"]);
  });

  it("splits only a saturated first-level bucket into second-level prefixes", async () => {
    const calls: string[] = [];
    const result = await readPartitionedSourceDate("2026-08-04", async (prefix) => {
      calls.push(prefix);
      if (prefix === "0x0") return [sourceRow("OVERFLOW_A", "0x00"), sourceRow("OVERFLOW_B", "0x01")];
      if (prefix === "0x00") return [sourceRow("POP_0", "0x0001")];
      if (prefix === "0x01") return [sourceRow("POP_1", "0x0101")];
      return [];
    }, 2);
    expect(calls).toHaveLength(32);
    expect(calls.slice(0, 17)).toEqual(["0x0", ...Array.from("0123456789abcdef", (digit) => `0x0${digit}`)]);
    expect(result.map((item) => item.condition_id)).toEqual(["0x0001", "0x0101"]);
  });

  it("fails closed when a second-level prefix remains saturated", async () => {
    await expect(readPartitionedSourceDate("2026-09-04", async (prefix) =>
      prefix === "0x0" || prefix === "0x00" ? [sourceRow("POP", `${prefix}01`)] : [], 1,
    )).rejects.toThrow("RECON_SOURCE_PARTITION_TOO_LARGE:2026-09-04:0x00");
  });

  it("rejects duplicate canonical identities after partition merging", async () => {
    const duplicate = sourceRow("POP", "0x01");
    await expect(readPartitionedSourceDate("2026-08-04", async (prefix) =>
      prefix === "0x0" || prefix === "0x1" ? [duplicate] : [], 3,
    )).rejects.toThrow("RECON_SOURCE_DUPLICATE_IDENTITY:2026-08-04");
  });
});

describe("market type lineage summary accounting", () => {
  it("counts unresolved and conflict once and preserves identity/event invariants", () => {
    const resolved = row({
      condition_id: "C_RESOLVED",
      selected_token_id: "T_RESOLVED",
      provider_event_id: "E_RESOLVED",
      canonical_row: { sportFamily: "soccer", marketTypeRaw: "moneyline" },
    });
    const unresolved = row({
      condition_id: "C_UNRESOLVED",
      selected_token_id: "T_UNRESOLVED",
      provider_event_id: "E_UNRESOLVED",
      canonical_row: { sportFamily: "soccer" },
    });
    const conflict = row({
      condition_id: "C_CONFLICT",
      selected_token_id: "T_CONFLICT",
      provider_event_id: "E_CONFLICT",
      canonical_row: { sportFamily: "soccer" },
    });
    const conflictIndex: MarketTypeResolverIndex = {
      researchContextExact: new Map(),
      fireModelHintExact: new Map(),
      conditionStatic: new Map(),
      evidencePageExact: new Map(),
      gspExact: new Map(),
      conflictingConditions: new Set(["C_CONFLICT"]),
    };
    const overlays = [resolved, unresolved].map((source) => buildOverlayRecord(source, new Map(), new Map()));
    overlays.push(buildOverlayRecord(conflict, new Map(), new Map(), conflictIndex));

    const summary = marketTypeLineageBreakdown(overlays);
    for (const level of [summary.IDENTITY, summary.PHYSICAL_EVENT]) {
      expect(level.UNRESOLVED_N).toBe(1);
      expect(level.CONFLICT_N).toBe(1);
      expect(level.RESOLVED_N).toBe(1);
      expect(level.RESOLVED_N + level.UNRESOLVED_N + level.CONFLICT_N).toBe(level.CANONICAL_SOCCER_N);
      const sourceAttributionN = [
        "FROM_CANONICAL_ROW_N",
        "FROM_RESEARCH_CONTEXT_EXACT_N",
        "FROM_FIREMODEL_HINT_EXACT_N",
        "FROM_CONDITION_STATIC_RECOVERY_N",
        "FROM_EVIDENCE_PAGE_N",
        "FROM_GSP_N",
        "CONFLICT_N",
        "UNRESOLVED_N",
      ].reduce((sum, key) => sum + level[key], 0);
      expect(sourceAttributionN).toBe(level.CANONICAL_SOCCER_N);
    }
  });
});

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
  const emptyResolver = (): MarketTypeResolverIndex => ({
    researchContextExact: new Map(),
    fireModelHintExact: new Map(),
    conditionStatic: new Map(),
    evidencePageExact: new Map(),
    gspExact: new Map(),
    conflictingConditions: new Set(),
  });

  it("prefers canonical_row.marketTypeRaw and normalizes it", () => {
    const r = row({ canonical_row: { marketTypeRaw: " Moneyline " } });
    const resolver = emptyResolver();
    resolver.researchContextExact.set("COND_1::TOK_1", ["totals"]);
    const result = resolveMarketType(r, new Map(), resolver);
    expect(result).toEqual({ source: "moneyline", reconciled: "moneyline", basis: "MARKET_TYPE_CANONICAL" });
  });

  it("recovers researchContext.marketType by exact condition and selected token", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", canonical_row: {} });
    const resolver = emptyResolver();
    resolver.researchContextExact.set("C9::T9", [" Totals "]);
    resolver.researchContextExact.set("C9::OTHER", ["spreads"]);
    expect(resolveMarketType(r, new Map(), resolver)).toEqual({
      source: "totals", reconciled: "totals", basis: "MARKET_TYPE_RESEARCH_CONTEXT_EXACT",
    });
  });

  it("uses fireModel.rawFeatureHints.marketType when the exact research context is absent", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", canonical_row: {} });
    const resolver = emptyResolver();
    resolver.fireModelHintExact.set("C9::T9", ["spreads"]);
    expect(resolveMarketType(r, new Map(), resolver)).toEqual({
      source: "spreads", reconciled: "spreads", basis: "MARKET_TYPE_FIREMODEL_HINT_EXACT",
    });
  });

  it("recovers a condition's unique static market type", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", canonical_row: {} });
    const resolver = emptyResolver();
    resolver.conditionStatic.set("C9", ["total_corners", " Total_Corners "]);
    expect(resolveMarketType(r, new Map(), resolver)).toEqual({
      source: "total_corners", reconciled: "total_corners", basis: "MARKET_TYPE_CONDITION_STATIC",
    });
  });

  it("fails closed when condition-level structured market types conflict", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", canonical_row: { marketTypeRaw: "moneyline" } });
    const resolver = emptyResolver();
    resolver.conflictingConditions.add("C9");
    expect(resolveMarketType(r, new Map(), resolver)).toEqual({
      source: null, reconciled: null, basis: "MARKET_TYPE_CONFLICT",
    });
    resolver.conflictingConditions.clear();
    resolver.conditionStatic.set("C9", ["moneyline", "totals"]);
    expect(resolveMarketType(r, new Map(), resolver).basis).toBe("MARKET_TYPE_CONFLICT");
  });

  it("uses the latest at-or-before exact evidence-page observation", () => {
    const r = row({ condition_id: "C9", selected_token_id: "T9", decision_at: "2026-08-05T10:00:00.000Z", canonical_row: {} });
    const resolver = emptyResolver();
    resolver.evidencePageExact.set("C9::T9", [
      { id: "1", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T08:00:00.000Z", market_type: "totals" },
      { id: "2", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T09:30:00.000Z", market_type: "moneyline" },
      { id: "3", condition_id: "C9", selected_token_id: "T9", created_at: "2026-08-05T12:00:00.000Z", market_type: "spreads" },
    ]);
    expect(resolveMarketType(r, new Map(), resolver)).toEqual({
      source: "moneyline", reconciled: "moneyline", basis: "MARKET_TYPE_EVIDENCE_PAGE_EXACT",
    });
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

  it("keeps unresolved values closed and never classifies from titles or slugs", () => {
    const unresolved = row({
      canonical_row: { eventTitle: "Exact Score: 2-1", marketQuestion: "Home Team to Win?" },
    });
    expect(resolveMarketType(unresolved, new Map(), emptyResolver())).toEqual({
      source: null, reconciled: null, basis: "MARKET_TYPE_UNRESOLVED",
    });
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
