// scripts/daily-ops-report.ts
// PolyProPicks Daily Operational Report
// Usage: npm run ops:report
// Prints human-readable Markdown to stdout.
// No DB writes. No UI changes. Read-only.

import { loadEnvConfig } from "@next/env";
import { execSync } from "child_process";

// ── Types ────────────────────────────────────────────────────────────────────

interface ResolvedRow {
  id: string;
  created_at: string;
  resolved_at: string | null;
  signal_result: string | null;
  signal_confidence_num: number | null;
  entry_price_num: number | null;
  realized_return_pct: number | null;
  metric_formula_version: string | null;
  event_slug: string | null;
  selected_outcome: string | null;
  premium_signal: Record<string, unknown> | null;
}

interface WindowStats {
  total: number;
  won: number;
  lost: number;
  push: number;
  winRate: string;
  avgConf: string;
  avgReturn: string;
  confTotal: number;
  confWon: number;
  confLost: number;
  confWinRate: string;
  confMissing: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}ч ${remMins}мин`;
}

function winRateFmt(won: number, lost: number): string {
  if (won + lost === 0) return "N/A";
  return `${Math.round((won / (won + lost)) * 1000) / 10}%`;
}

function avgOrNA(vals: (number | null)[]): string {
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length === 0) return "N/A";
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return `${Math.round(avg * 10) / 10}`;
}

function avgReturnFmt(vals: (number | null)[]): string {
  const s = avgOrNA(vals);
  return s === "N/A" ? "N/A" : `${s}%`;
}

const PUSH_RESULTS = new Set([
  "push", "refund", "tie", "void", "cancelled", "no_contest",
]);

function inferLeague(
  eventSlug: string | null,
  ps: Record<string, unknown> | null,
): string {
  const league = safeStr(ps?.league);
  if (league) return league;
  const title = (safeStr(eventSlug) ?? "").toLowerCase();
  if (/\blol\b|lck|lpl|lec|league of legends/.test(title)) return "Esports";
  if (/valorant|cs2|dota|esport|gaming/.test(title)) return "Esports";
  if (/nba|wnba|basketball|bucks|lakers|celtics|warriors|heat|knicks|sixers|mystics|storm/.test(title)) return "NBA";
  if (/nhl|hockey|avalanche|rangers|bruins|flyers|capitals|panthers|hurricanes|canadiens/.test(title)) return "NHL";
  if (/nfl|super bowl|chiefs|eagles|packers|cowboys|patriots/.test(title)) return "NFL";
  if (/mlb|baseball|yankees|red sox|dodgers|mets|cubs|braves|rays|orioles|mariners|padres|phillies|marlins|reds|angels|twins|diamondbacks|giants|nationals|guardians|athletics|blue jays/.test(title)) return "MLB";
  if (/roland garros|wimbledon|us open|atp|wta|tennis|borges|kecman|davidovich/.test(title)) return "Tennis";
  if (/premier league|la liga|bundesliga|serie a|copa|champions|soccer|mls|world cup|wc26|independiente/.test(title)) return "Soccer";
  return "Unknown";
}

function extractConf(row: ResolvedRow): number | null {
  return (
    safeNum(row.signal_confidence_num) ??
    safeNum(row.premium_signal?.winProbability) ??
    safeNum(row.premium_signal?.signalConfidence) ??
    safeNum(row.premium_signal?.displaySignalConfidence)
  );
}

function computeWindow(rows: ResolvedRow[]): WindowStats {
  let won = 0,
    lost = 0,
    push = 0;
  let confTotal = 0,
    confWon = 0,
    confLost = 0,
    confMissing = 0;
  const confs: (number | null)[] = [];
  const returns: (number | null)[] = [];

  for (const r of rows) {
    const result = r.signal_result ?? "unknown";
    if (result === "won") won++;
    else if (result === "lost") lost++;
    else if (PUSH_RESULTS.has(result)) push++;

    const conf = extractConf(r);
    confs.push(conf);
    returns.push(safeNum(r.realized_return_pct));

    if (conf === null) {
      confMissing++;
    } else if (conf >= 70) {
      confTotal++;
      if (result === "won") confWon++;
      if (result === "lost") confLost++;
    }
  }

  return {
    total: rows.length,
    won,
    lost,
    push,
    winRate: winRateFmt(won, lost),
    avgConf: avgOrNA(confs),
    avgReturn: avgReturnFmt(returns),
    confTotal,
    confWon,
    confLost,
    confWinRate: winRateFmt(confWon, confLost),
    confMissing,
  };
}

function execGit(cmd: string): string {
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "N/A";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Must be first: load .env.local before any import reads process.env
  loadEnvConfig(process.cwd());

  const now = new Date();
  const nowISO = now.toISOString();
  // Report header timestamp in GMT+3
  const gmt3 = new Date(now.getTime() + 3 * 3_600_000);
  const reportDate =
    gmt3.toISOString().replace("T", " ").slice(0, 16) + " GMT+3";

  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  const redFlags: string[] = [];

  // ── 1. Git / Deploy state ─────────────────────────────────────────────────
  const headShort = execGit("git rev-parse --short HEAD");
  const headMsg = execGit("git log -1 --format=%s");
  const originShort = execGit("git rev-parse --short origin/main");
  const gitStatus = execGit("git status --short");
  const localMatchesOrigin =
    headShort !== "N/A" && headShort === originShort;
  const dirtyTracked = gitStatus
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("??"));

  if (!localMatchesOrigin)
    redFlags.push(
      `⚠️ local HEAD (${headShort}) ≠ origin/main (${originShort})`,
    );
  if (dirtyTracked.length > 0)
    redFlags.push(
      `⚠️ Git: tracked dirty файлы: ${dirtyTracked.join(", ")}`,
    );

  // ── 2. Feed freshness ─────────────────────────────────────────────────────
  type FeedPair = Record<string, unknown>;
  let feedGeneratedAt: string | null = null;
  let feedCacheStatus: string | null = null;
  let feedFormula: string | null = null;
  let feedPairs: FeedPair[] = [];
  let feedError: string | null = null;

  try {
    const res = await fetch(
      "https://polypropicks.com/api/feed/landing-cards?limit=15",
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    feedGeneratedAt = safeStr(d.generatedAt);
    feedCacheStatus = safeStr(d.cacheStatus);
    feedFormula = safeStr(d.formulaVersion);
    feedPairs = Array.isArray(d.pairs) ? (d.pairs as FeedPair[]) : [];
  } catch (e) {
    feedError = e instanceof Error ? e.message : String(e);
    redFlags.push(`❌ Feed API недоступен: ${feedError}`);
  }

  const feedAgeMs = feedGeneratedAt
    ? Date.now() - new Date(feedGeneratedAt).getTime()
    : null;
  const feedAgeMins =
    feedAgeMs !== null ? Math.round(feedAgeMs / 60_000) : null;
  if (feedAgeMins !== null && feedAgeMins > 90)
    redFlags.push(`❌ Feed кэш старше 90 мин (${feedAgeMins} мин)`);

  // Feed composition: leagues and confidence
  const leagueCounts: Record<string, number> = {};
  const feedConfCounts = { total: 0, ge70: 0 };
  const topTitles: string[] = [];

  for (const p of feedPairs) {
    const ps = p.premiumSignal as Record<string, unknown> | null | undefined;
    const league = safeStr(ps?.league) ?? "Unknown";
    leagueCounts[league] = (leagueCounts[league] ?? 0) + 1;
    feedConfCounts.total++;
    const conf =
      safeNum(ps?.displaySignalConfidence) ?? safeNum(ps?.winProbability);
    if (conf !== null && conf >= 70) feedConfCounts.ge70++;
    const title =
      safeStr(ps?.eventTitle) ?? safeStr(ps?.title) ?? safeStr(ps?.market);
    if (title && topTitles.length < 5) topTitles.push(title);
  }

  // ── 3. Supabase ───────────────────────────────────────────────────────────
  // Dynamic import ensures loadEnvConfig ran first
  type SupabaseClient = Awaited<
    typeof import("../lib/supabase/server")
  >["supabaseAdmin"];
  let supabase: SupabaseClient | null = null;
  let dbConnectError: string | null = null;

  try {
    const mod = await import("../lib/supabase/server");
    supabase = mod.supabaseAdmin;
  } catch (e) {
    dbConnectError = e instanceof Error ? e.message : String(e);
    redFlags.push(`❌ Supabase init failed: ${dbConnectError}`);
  }

  // ── 3a. Cache-cron health via job_runs ────────────────────────────────────
  let lastJobRun: Record<string, unknown> | null = null;
  let jobRunError: string | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("job_runs")
        .select(
          "source, started_at, finished_at, status, generated_count, rejected_count, duration_ms, error_message",
        )
        .eq("source", "polymarket")
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      lastJobRun =
        data && data.length > 0
          ? (data[0] as Record<string, unknown>)
          : null;
    } catch (e) {
      jobRunError = e instanceof Error ? e.message : String(e);
      redFlags.push(`⚠️ job_runs недоступен: ${jobRunError}`);
    }
  }

  const cronLastAt = lastJobRun ? safeStr(lastJobRun.started_at) : null;
  const cronAgeMs = cronLastAt
    ? Date.now() - new Date(cronLastAt).getTime()
    : null;
  const cronAgeMins =
    cronAgeMs !== null ? Math.round(cronAgeMs / 60_000) : null;
  if (cronAgeMins !== null && cronAgeMins > 120)
    redFlags.push(
      `❌ Cache-cron: последний запуск ${cronAgeMins} мин назад (порог 120 мин)`,
    );
  if (!cronLastAt && !jobRunError)
    redFlags.push(`⚠️ job_runs: нет записей для source=polymarket`);

  // ── 3b. Resolved performance (direct DB, 72h window) ─────────────────────
  const cutoff72 = new Date(now.getTime() - 72 * 3_600_000).toISOString();
  const cutoff48 = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const cutoff24 = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  let resolvedRows: ResolvedRow[] = [];
  let resolvedError: string | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("generated_signal_pairs")
        .select(
          "id, created_at, resolved_at, signal_result, signal_confidence_num, " +
          "entry_price_num, realized_return_pct, metric_formula_version, " +
          "event_slug, selected_outcome, premium_signal",
        )
        .not("signal_result", "is", null)
        .gte("resolved_at", cutoff72)
        .order("resolved_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      resolvedRows = (data ?? []) as unknown as ResolvedRow[];
    } catch (e) {
      resolvedError = e instanceof Error ? e.message : String(e);
      redFlags.push(`❌ Resolved stats: ${resolvedError}`);
    }
  }

  const rows72 = resolvedRows;
  const rows48 = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff48,
  );
  const rows24 = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff24,
  );

  const stats72 = computeWindow(rows72);
  const stats48 = computeWindow(rows48);
  const stats24 = computeWindow(rows24);

  if (stats24.total === 0)
    redFlags.push(`⚠️ За 24h нет resolved сигналов`);
  if (stats24.total >= 10) {
    const wr =
      stats24.won + stats24.lost > 0
        ? stats24.won / (stats24.won + stats24.lost)
        : null;
    if (wr !== null && wr < 0.45)
      redFlags.push(
        `⚠️ Win rate за 24h ниже 45% (${stats24.winRate} при ${stats24.total} сигналах)`,
      );
  }
  if (stats24.confTotal === 0 && stats24.total > 0)
    redFlags.push(`⚠️ Нет resolved с confidence≥70 за 24h`);

  // ── 3c. Resolver health (approximation) ───────────────────────────────────
  let latestResolvedAt: string | null =
    resolvedRows.length > 0 ? (resolvedRows[0].resolved_at ?? null) : null;
  let unresolvedCount: number | null = null;
  let oldestUnresolved: string | null = null;
  let unresolvedError: string | null = null;

  if (supabase) {
    // If no rows in 72h, try latest globally
    if (!latestResolvedAt) {
      try {
        const { data } = await supabase
          .from("generated_signal_pairs")
          .select("resolved_at")
          .not("signal_result", "is", null)
          .order("resolved_at", { ascending: false })
          .limit(1);
        latestResolvedAt = (data?.[0] as { resolved_at?: string } | undefined)?.resolved_at ?? null;
      } catch { /* non-fatal */ }
    }

    try {
      const { count, error } = await supabase
        .from("generated_signal_pairs")
        .select("id", { count: "exact", head: true })
        .is("signal_result", null)
        .not("metric_formula_version", "is", null);
      if (error) throw new Error(error.message);
      unresolvedCount = count ?? 0;
    } catch (e) {
      unresolvedError = e instanceof Error ? e.message : String(e);
    }

    if (!unresolvedError) {
      try {
        const { data: oldest } = await supabase
          .from("generated_signal_pairs")
          .select("created_at")
          .is("signal_result", null)
          .not("metric_formula_version", "is", null)
          .order("created_at", { ascending: true })
          .limit(1);
        oldestUnresolved =
          (oldest?.[0] as { created_at?: string } | undefined)?.created_at ??
          null;
      } catch { /* non-fatal */ }
    }
  }

  const resolverAgeMs = latestResolvedAt
    ? Date.now() - new Date(latestResolvedAt).getTime()
    : null;
  const resolverAgeMins =
    resolverAgeMs !== null ? Math.round(resolverAgeMs / 60_000) : null;

  if (resolverAgeMins !== null && resolverAgeMins > 480)
    redFlags.push(
      `⚠️ Resolver: последний resolved_at ${resolverAgeMins} мин назад (>8h)`,
    );
  if (unresolvedCount !== null && unresolvedCount > 200)
    redFlags.push(`⚠️ Unresolved backlog ${unresolvedCount} строк (порог 200)`);

  // ── 3d. League split (24h) ────────────────────────────────────────────────
  const leagueStats24: Record<
    string,
    { total: number; won: number; lost: number; confs: (number | null)[] }
  > = {};
  for (const r of rows24) {
    const league = inferLeague(r.event_slug, r.premium_signal);
    if (!leagueStats24[league])
      leagueStats24[league] = { total: 0, won: 0, lost: 0, confs: [] };
    const s = leagueStats24[league];
    s.total++;
    if (r.signal_result === "won") s.won++;
    if (r.signal_result === "lost") s.lost++;
    s.confs.push(extractConf(r));
  }

  // ── Build Markdown ─────────────────────────────────────────────────────────

  const feedEmoji =
    feedError ? "❌" : feedAgeMins !== null && feedAgeMins <= 90 ? "✅" : "⚠️";
  const cronEmoji = jobRunError
    ? "⚠️"
    : !cronLastAt
      ? "⚠️"
      : cronAgeMins !== null && cronAgeMins <= 120
        ? "✅"
        : "❌";
  const resolverEmoji =
    resolverAgeMins === null
      ? "❓"
      : resolverAgeMins <= 480
        ? "✅ (approx)"
        : "⚠️";

  out(`# PolyProPicks Daily Ops Report — ${reportDate}`);
  out(``);
  out(
    `> Generated: ${fmtDate(nowISO)} | Run: \`npm run ops:report\``,
  );
  out(``);

  // Executive Summary
  out(`## 📋 Executive Summary`);
  out(``);
  out(`| Компонент | Статус | Детали |`);
  out(`|-----------|--------|--------|`);
  out(
    `| Feed | ${feedEmoji} | ${
      feedError
        ? feedError
        : `Возраст кэша: ${feedAgeMins} мин, status: ${feedCacheStatus}`
    } |`,
  );
  out(
    `| Cache-cron | ${cronEmoji} | ${
      jobRunError
        ? "job_runs недоступен"
        : !cronLastAt
          ? "Нет записей в job_runs"
          : `Последний: ${fmtAge(cronLastAt)} назад (${safeStr(lastJobRun?.status) ?? "?"})`
    } |`,
  );
  out(
    `| Resolver (approx) | ${resolverEmoji} | Нет job_runs. Последний resolved_at: ${fmtAge(latestResolvedAt)} назад |`,
  );
  out(
    `| 24h Win rate | ${stats24.total > 0 ? stats24.winRate : "N/A"} | ${stats24.won}W / ${stats24.lost}L / ${stats24.total} total |`,
  );
  out(
    `| 24h Conf≥70 Win rate | ${stats24.confTotal > 0 ? stats24.confWinRate : "N/A"} | ${stats24.confWon}W / ${stats24.confLost}L / ${stats24.confTotal} сигналов |`,
  );
  out(
    `| Red flags | ${redFlags.length === 0 ? "✅ 0" : `⚠️ ${redFlags.length}`} | Смотри секцию Red Flags |`,
  );
  out(``);

  // Deploy State
  out(`## 🚀 Deploy State`);
  out(``);
  out(`| Поле | Значение |`);
  out(`|------|----------|`);
  out(`| Local HEAD | \`${headShort}\` |`);
  out(`| Commit | ${headMsg} |`);
  out(`| origin/main | \`${originShort}\` |`);
  out(
    `| Синхронизирован? | ${localMatchesOrigin ? "✅ Да" : "❌ Нет — проверь push"} |`,
  );
  out(
    `| Git working tree | ${dirtyTracked.length === 0 ? "✅ Чистый" : `⚠️ Dirty: ${dirtyTracked.join("; ")}`} |`,
  );
  out(
    `| Railway deploy | ⚠️ Не верифицирован (нет /api/health, нет NEXT_PUBLIC_COMMIT_SHA) |`,
  );
  out(``);

  // Feed Freshness
  out(`## 📡 Feed Freshness`);
  out(``);
  if (feedError) {
    out(`> ❌ Feed API недоступен: ${feedError}`);
  } else {
    out(`| Поле | Значение |`);
    out(`|------|----------|`);
    out(`| generatedAt | ${fmtDate(feedGeneratedAt)} |`);
    out(`| Возраст кэша | ${feedAgeMins} мин |`);
    out(`| cacheStatus | ${feedCacheStatus ?? "N/A"} |`);
    out(`| formulaVersion | ${feedFormula ?? "N/A"} |`);
    out(`| Пар в feed | ${feedPairs.length} |`);
    out(
      `| Confidence≥70 пар | ${feedConfCounts.ge70} / ${feedConfCounts.total} |`,
    );
  }
  out(``);

  // Feed Composition
  out(`## 🃏 Current Feed Composition`);
  out(``);
  if (feedPairs.length === 0) {
    out(`> ⚠️ Feed пустой или недоступен`);
  } else {
    out(`| Лига | Карт |`);
    out(`|------|------|`);
    for (const [league, count] of Object.entries(leagueCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      out(`| ${league} | ${count} |`);
    }
    if (topTitles.length > 0) {
      out(``);
      out(`**Топ событий:**`);
      for (const t of topTitles) out(`- ${t}`);
    }
  }
  out(``);

  // Cron Health
  out(`## ⏰ Cron Health`);
  out(``);
  out(`| Сервис | Статус | Последний запуск | Сгенерировано | Длительность |`);
  out(
    `|--------|--------|-----------------|---------------|--------------|`,
  );
  if (jobRunError) {
    out(
      `| signal-cache-cron | ⚠️ WARNING | job_runs недоступен | — | — |`,
    );
  } else if (!lastJobRun) {
    out(`| signal-cache-cron | ⚠️ Нет записей | — | — | — |`);
  } else {
    const status = safeStr(lastJobRun.status);
    const emoji =
      status === "success" ? "✅" : status === "error" ? "❌" : "⚠️";
    const genCount = lastJobRun.generated_count ?? "?";
    const dur = lastJobRun.duration_ms ?? "?";
    out(
      `| signal-cache-cron | ${emoji} ${status ?? "?"} | ${fmtDate(safeStr(lastJobRun.started_at))} (${fmtAge(safeStr(lastJobRun.started_at))} назад) | ${genCount} пар | ${dur}ms |`,
    );
  }
  out(
    `| signal-resolve-cron | ❓ BLIND | Нет записи в job_runs (не инструментирован) | — | — |`,
  );
  out(``);
  out(
    `> ⚠️ Resolver BLIND: \`resolve-signals.ts\` не пишет в \`job_runs\`. Аппроксимация через \`resolved_at\`. Инструментирование — отдельная P1 задача.`,
  );
  out(``);

  // Performance
  out(`## 📊 Performance: Resolved 24h / 48h / 72h`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен: ${resolvedError}`);
  } else {
    out(`| Окно | Всего | Won | Lost | Push | Win% | Avg Conf | Avg Return |`);
    out(
      `|------|-------|-----|------|------|------|----------|------------|`,
    );
    for (const [label, s] of [
      ["24h", stats24],
      ["48h", stats48],
      ["72h", stats72],
    ] as [string, WindowStats][]) {
      out(
        `| ${label} | ${s.total} | ${s.won} | ${s.lost} | ${s.push} | ${s.winRate} | ${s.avgConf} | ${s.avgReturn} |`,
      );
    }
  }
  out(``);

  // Confidence >=70
  out(`## 🎯 Confidence ≥70 Performance`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен`);
  } else {
    out(
      `| Окно | Conf≥70 total | Won | Lost | Win% | Conf null (пропущено) |`,
    );
    out(
      `|------|--------------|-----|------|------|-----------------------|`,
    );
    for (const [label, s] of [
      ["24h", stats24],
      ["48h", stats48],
      ["72h", stats72],
    ] as [string, WindowStats][]) {
      out(
        `| ${label} | ${s.confTotal} | ${s.confWon} | ${s.confLost} | ${s.confWinRate} | ${s.confMissing} |`,
      );
    }
  }
  out(``);

  // League split
  out(`## 🏟️ League Split (24h)`);
  out(``);
  if (resolvedError || rows24.length === 0) {
    out(`> ⚠️ Нет данных за 24h`);
  } else {
    out(`| Лига | Resolved | Won | Lost | Win% | Avg Conf |`);
    out(`|------|----------|-----|------|------|----------|`);
    for (const [league, s] of Object.entries(leagueStats24).sort(
      (a, b) => b[1].total - a[1].total,
    )) {
      out(
        `| ${league} | ${s.total} | ${s.won} | ${s.lost} | ${winRateFmt(s.won, s.lost)} | ${avgOrNA(s.confs)} |`,
      );
    }
  }
  out(``);

  // Latest resolved
  out(`## 🔎 Latest Resolved Signals (max 10)`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен`);
  } else if (resolvedRows.length === 0) {
    out(`> Нет resolved сигналов за 72h`);
  } else {
    out(`| # | Матч | Pick | Result | Conf | Return | Resolved |`);
    out(`|---|------|------|--------|------|--------|----------|`);
    for (const [i, r] of resolvedRows.slice(0, 10).entries()) {
      const title = (
        safeStr(r.event_slug) ??
        safeStr(r.premium_signal?.eventTitle) ??
        safeStr(r.premium_signal?.title) ??
        "?"
      ).slice(0, 38);
      const pick = (safeStr(r.selected_outcome) ?? "?").slice(0, 22);
      const resEmoji =
        r.signal_result === "won"
          ? "✅ WON"
          : r.signal_result === "lost"
            ? "❌ LOST"
            : (r.signal_result ?? "?");
      const conf = extractConf(r);
      const ret =
        r.realized_return_pct !== null
          ? `${r.realized_return_pct > 0 ? "+" : ""}${Math.round(r.realized_return_pct)}%`
          : "N/A";
      out(
        `| ${i + 1} | ${title} | ${pick} | ${resEmoji} | ${conf ?? "?"} | ${ret} | ${fmtDate(r.resolved_at)} |`,
      );
    }
  }
  out(``);

  // Unresolved backlog
  out(`## 📦 Unresolved Backlog`);
  out(``);
  out(`| Поле | Значение |`);
  out(`|------|----------|`);
  out(
    `| Unresolved count | ${
      unresolvedError
        ? `⚠️ Ошибка: ${unresolvedError}`
        : (unresolvedCount ?? "N/A")
    } |`,
  );
  out(`| Oldest unresolved created_at | ${fmtDate(oldestUnresolved)} |`);
  out(`| Latest resolved_at (global) | ${fmtDate(latestResolvedAt)} |`);
  out(
    `| Resolver gap | ${resolverAgeMins !== null ? `${resolverAgeMins} мин назад` : "N/A"} |`,
  );
  out(
    `| Resolver health | ❓ BLIND — нет job_runs записи для resolver |`,
  );
  out(``);

  // Red Flags
  out(`## 🔴 Red Flags / Action Items`);
  out(``);
  if (redFlags.length === 0) {
    out(`✅ Все системы в норме. Критических нарушений нет.`);
  } else {
    for (const f of redFlags) out(`- ${f}`);
  }
  out(``);
  out(`---`);
  out(
    `*Отчёт сформирован: ${fmtDate(nowISO)} | PolyProPicks Ops Report v1.0*`,
  );

  // Print to stdout
  console.log(lines.join("\n"));

  // Exit 1 only if no data at all could be gathered
  if (dbConnectError && feedError) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(
    "[ops-report] Fatal:",
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
