import { FireRow } from "./queryRunner";

export type NormalizedCandidate = {
  row_id: string;
  created_at: string;
  resolved_at: string;
  condition_id: string;
  selected_token_id: string;
  selected_outcome: string;
  event_slug: string;
  market_slug: string;
  fixture_key: string;
  sport: string;
  league: string;
  market_family: string;
  tier: string;
  score: number | null;
  coverage: number | null;
  entry_price: number | null;
  result: "win" | "loss" | "push" | "unknown";
  pnl10: number | null;
};

export type ModelMetricRow = {
  rank: number;
  model_id: string;
  role: string;
  status: string;
  sports_scope: string;
  tiers_supported: string;
  all_time_N_bets: number;
  all_time_N_fixtures: number;
  all_time_turnover: number;
  all_time_pnl: number;
  all_time_roi: number;
  all_time_maxDD: number;
  all_time_pnl_over_maxDD: number | null;
  "96h_N_bets": number;
  "96h_N_fixtures": number;
  "96h_turnover": number;
  "96h_pnl": number;
  "96h_roi": number;
  "96h_maxDD": number;
  avg_bets_per_fixture: number;
  allowed_families: string;
  blocked_families: string;
  verdict: string;
  rollback_note: string;
};

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function num(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(String(value).replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function resultOf(row: FireRow): "win" | "loss" | "push" | "unknown" {
  const raw = str(row.signal_result ?? row.result ?? row.outcome).toLowerCase();
  if (/win|won|true|success/.test(raw)) return "win";
  if (/loss|lost|false|fail/.test(raw)) return "loss";
  if (/push|refund|void|draw/.test(raw)) return "push";
  return "unknown";
}

function pnl10(result: "win" | "loss" | "push" | "unknown", price: number | null): number | null {
  if (result === "unknown" || price == null || price <= 0) return null;
  if (result === "win") return 10 * (1 / price - 1);
  if (result === "loss") return -10;
  return 0;
}

export function marketFamily(row: FireRow): string {
  const d = jsonObject(row.diagnostics);
  const text = [
    row.market_family,
    row.market_type,
    row.market_slug,
    row.event_slug,
    d.marketFamily,
    d.market_family,
    d.marketType,
    d.marketTitle,
  ].map(str).join(" ").toLowerCase();
  if (/matched activity|live market activity|\$\d+k/.test(text)) return "matched_activity";
  if (/corner/.test(text)) return "corners";
  if (/team total/.test(text)) return "team_total";
  if (/halftime|half-time|\bht\b/.test(text)) return "halftime";
  if (/both teams|btts/.test(text)) return "both_teams_to_score";
  if (/first team/.test(text)) return "first_team_to_score";
  if (/spread|handicap|\+[0-9.]+|-[0-9.]+/.test(text)) return "spread";
  if (/total|over\/under|over-under|\bo\/u\b/.test(text)) return "total";
  if (/moneyline|winner|wins|draw/.test(text)) return "moneyline";
  return row.market_family ? str(row.market_family) : "other";
}

function sportBucket(row: FireRow): string {
  const d = jsonObject(row.diagnostics);
  const text = [row.sport, row.sport_or_scope, row.league, row.event_slug, d.sport, d.league, d.strategic_scope]
    .map(str)
    .join(" ")
    .toLowerCase();
  if (/nba|basketball/.test(text)) return "NBA";
  if (/nhl|hockey/.test(text)) return "NHL";
  if (/nfl|football american/.test(text)) return "NFL";
  if (/mlb|baseball/.test(text)) return "MLB";
  if (/tennis/.test(text)) return "tennis";
  if (/esport|valorant|counter-strike|league of legends|dota/.test(text)) return "esports";
  if (/soccer|fifwc|world cup|football/.test(text)) return /fifwc|world cup|wc/.test(text) ? "soccer/WC" : "soccer";
  return "other";
}

function tierOf(row: FireRow, score: number | null): string {
  const d = jsonObject(row.diagnostics);
  const raw = str(row.tier ?? row.tier_model ?? d.tier ?? d.tier_model ?? d.liveTier).toUpperCase();
  if (/TIER\s*1|TIER1/.test(raw)) return "TIER1";
  if (/TIER\s*2|TIER2/.test(raw)) return "TIER2";
  if (/TIER\s*3|TIER3/.test(raw)) return "TIER3";
  if (score != null && score >= 72) return "TIER1";
  if (score != null && score >= 65) return "TIER2";
  if (score != null && score >= 60) return "TIER3";
  return "UNKNOWN";
}

export function normalizeCandidates(rows: FireRow[]): NormalizedCandidate[] {
  const strict = new Map<string, FireRow>();
  for (const row of rows) {
    const condition = str(row.condition_id);
    const token = str(row.selected_token_id ?? row.token_id ?? row.outcome_token_id);
    if (!condition || !token) continue;
    const key = `${condition}::${token}`;
    const prev = strict.get(key);
    const currentTime = Date.parse(str(row.resolved_at || row.created_at));
    const prevTime = prev ? Date.parse(str(prev.resolved_at || prev.created_at)) : -Infinity;
    if (!prev || currentTime >= prevTime) strict.set(key, row);
  }
  return [...strict.values()].map((row) => {
    const d = jsonObject(row.diagnostics);
    const score = num(row.signal_confidence_num, row.score, row.pre_event_score_num, d.score, d.signalScore, d.confidence);
    const coverage = num(row.data_coverage_num, row.coverage, row.data_coverage, d.dataCoverage, d.coverage);
    const price = num(row.entry_price_num, row.entry_price, row.selected_price_num, row.selected_price, row.price, d.entryPrice, d.selectedPrice);
    const result = resultOf(row);
    const family = marketFamily(row);
    const eventSlug = str(row.event_slug || d.event_slug || d.eventSlug || row.event_key);
    const fixture = eventSlug || str(row.market_slug || row.condition_id);
    return {
      row_id: str(row.id),
      created_at: str(row.created_at),
      resolved_at: str(row.resolved_at || row.created_at),
      condition_id: str(row.condition_id),
      selected_token_id: str(row.selected_token_id ?? row.token_id ?? row.outcome_token_id),
      selected_outcome: str(row.selected_outcome ?? row.selected_side ?? row.side),
      event_slug: eventSlug,
      market_slug: str(row.market_slug),
      fixture_key: fixture.toLowerCase(),
      sport: sportBucket(row),
      league: str(row.league),
      market_family: family,
      tier: tierOf(row, score),
      score,
      coverage,
      entry_price: price,
      result,
      pnl10: pnl10(result, price),
    };
  });
}

export function maxDrawdown(pnls: number[]): number {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const pnl of pnls) {
    eq += pnl;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

export function metric(rows: NormalizedCandidate[], anchorMs: number, hours: number | null) {
  const windowRows = hours == null ? rows : rows.filter((row) => Date.parse(row.resolved_at) >= anchorMs - hours * 3600_000);
  const valid = windowRows.filter((row) => row.pnl10 != null) as Array<NormalizedCandidate & { pnl10: number }>;
  const ordered = [...valid].sort((a, b) => Date.parse(a.resolved_at) - Date.parse(b.resolved_at));
  const pnl = ordered.reduce((sum, row) => sum + row.pnl10, 0);
  const turnover = ordered.length * 10;
  const fixtures = new Set(ordered.map((row) => row.fixture_key)).size;
  const dd = maxDrawdown(ordered.map((row) => row.pnl10));
  return {
    N_bets: ordered.length,
    N_fixtures: fixtures,
    turnover,
    pnl,
    roi: turnover ? (pnl / turnover) * 100 : 0,
    maxDD: dd,
    pnl_over_maxDD: dd > 0 ? pnl / dd : null,
    wins: ordered.filter((row) => row.result === "win").length,
    losses: ordered.filter((row) => row.result === "loss").length,
    pushes: ordered.filter((row) => row.result === "push").length,
  };
}

export function onePerFixture(rows: NormalizedCandidate[]): NormalizedCandidate[] {
  const groups = new Map<string, NormalizedCandidate[]>();
  for (const row of rows) groups.set(row.fixture_key, [...(groups.get(row.fixture_key) ?? []), row]);
  return [...groups.values()].map((group) =>
    [...group].sort((a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      Date.parse(a.created_at || a.resolved_at) - Date.parse(b.created_at || b.resolved_at),
    )[0],
  );
}

export function maxTwoPerFixture(rows: NormalizedCandidate[]): NormalizedCandidate[] {
  const groups = new Map<string, NormalizedCandidate[]>();
  for (const row of rows) groups.set(row.fixture_key, [...(groups.get(row.fixture_key) ?? []), row]);
  return [...groups.values()].flatMap((group) =>
    [...group].sort((a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      (b.coverage ?? -1) - (a.coverage ?? -1) ||
      Date.parse(a.created_at || a.resolved_at) - Date.parse(b.created_at || b.resolved_at),
    ).slice(0, 2),
  );
}

export function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], headers: string[]): string {
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n") + "\n";
}
