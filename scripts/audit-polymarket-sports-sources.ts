// Polymarket source coverage audit — read-only, no secrets, no DB writes, no file mutation.
// Compares official Polymarket sports pages against our production feed category counts
// to catch source-coverage drift (e.g. WC26 games present on Polymarket but our feed shows 0).
//
// Run: npm run audit:sports-sources
// Exit code: 0 = PASS/WARN, 1 = FAIL/P0 drift.

const PROD_FEED_URL =
  "https://polypropicks.com/api/feed/landing-cards?limit=15&includeUpcoming=true&category=sports&minDataCoverage=40&excludeEnded=true";

interface CategorySpec {
  key: "wc26" | "nba" | "nhl" | "esport";
  label: string;
  // Returns true if a pair's combined text belongs to this category.
  match: (text: string) => boolean;
  // Official Polymarket page(s) — primary source of truth, NOT Gamma.
  officialUrls: string[];
  // Soft text markers. Presence => page looks populated. Absence is not a hard fail.
  markers: string[];
}

const CATEGORIES: CategorySpec[] = [
  {
    key: "wc26",
    label: "WC26",
    match: (t) => /world cup|wc26|wc2026|fifa/.test(t),
    officialUrls: ["https://polymarket.com/sports/fifa-world-cup/games"],
    markers: ["fifa world cup", "moneyline", "games"],
  },
  {
    key: "nba",
    label: "NBA",
    match: (t) => /\bnba\b|basketball/.test(t),
    officialUrls: ["https://polymarket.com/sports/nba/games"],
    markers: ["nba", "games"],
  },
  {
    key: "nhl",
    label: "NHL",
    match: (t) => /\bnhl\b|hockey/.test(t),
    officialUrls: ["https://polymarket.com/sports/nhl/games"],
    markers: ["nhl", "games"],
  },
  {
    key: "esport",
    label: "eSport",
    match: (t) =>
      /esport|esports|cs2|csgo|counter[ -]strike|dota|valorant|league of legends|\blol\b/.test(t),
    officialUrls: ["https://polymarket.com/esports"],
    markers: ["esports"],
  },
];

// Signal-quality hazards that must never appear in production JSON.
const HAZARD_PATTERNS: Array<{ label: string; test: (raw: string) => boolean }> = [
  { label: "Market Watch position", test: (r) => /"position"\s*:\s*"market watch"/i.test(r) },
  { label: "Pending profit", test: (r) => /"profit"\s*:\s*"pending"/i.test(r) },
  { label: "Odds -10000", test: (r) => /-10000/.test(r) },
  { label: "+$1 fake payout", test: (r) => /"\+?\$1"/.test(r) },
];

async function safeText(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: "text/html,application/json" } });
    clearTimeout(timeout);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: `FETCH_ERROR: ${String(err)}` };
  }
}

interface OfficialStatus {
  url: string;
  reachable: boolean;
  status: number;
  markersFound: string[];
  looksPopulated: boolean;
}

async function checkOfficial(spec: CategorySpec): Promise<OfficialStatus[]> {
  const results: OfficialStatus[] = [];
  for (const url of spec.officialUrls) {
    const { ok, status, body } = await safeText(url);
    const lower = body.toLowerCase();
    const markersFound = spec.markers.filter((m) => lower.includes(m));
    results.push({
      url,
      reachable: ok,
      status,
      markersFound,
      // "Populated" heuristic: reachable AND at least one marker present.
      looksPopulated: ok && markersFound.length > 0,
    });
  }
  return results;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("=".repeat(60));
  console.log(`Polymarket Source Coverage Audit — ${startedAt}`);
  console.log("=".repeat(60));

  // 1) Production feed.
  const feed = await safeText(PROD_FEED_URL);
  if (!feed.ok) {
    console.log(`FAIL: production feed unreachable (status ${feed.status})`);
    process.exit(1);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(feed.body) as Record<string, unknown>;
  } catch {
    console.log("FAIL: production feed returned non-JSON");
    process.exit(1);
  }

  const pairs = [
    ...(Array.isArray(json.pairs) ? (json.pairs as unknown[]) : []),
    ...(Array.isArray(json.upcomingPairs) ? (json.upcomingPairs as unknown[]) : []),
  ];
  console.log(`cacheStatus: ${json.cacheStatus ?? "?"} | formulaVersion: ${json.formulaVersion ?? "?"}`);
  console.log(`total pairs: ${pairs.length}`);

  // 2) Category counts from production pairs.
  const counts: Record<string, number> = { wc26: 0, nba: 0, nhl: 0, esport: 0 };
  for (const p of pairs) {
    const obj = p as { premiumSignal?: { league?: string; eventTitle?: string }; marketSource?: { headline?: string } };
    const text = `${obj.premiumSignal?.league ?? ""} ${obj.premiumSignal?.eventTitle ?? ""} ${obj.marketSource?.headline ?? ""}`.toLowerCase();
    for (const c of CATEGORIES) {
      if (c.match(text)) counts[c.key]++;
    }
  }

  // 3) Hazard scan over raw JSON.
  const hazards = HAZARD_PATTERNS.filter((h) => h.test(feed.body)).map((h) => h.label);

  // 4) Official source checks.
  const alerts: string[] = [];
  console.log("\n--- Category coverage ---");
  for (const c of CATEGORIES) {
    const official = await checkOfficial(c);
    const populated = official.some((o) => o.looksPopulated);
    const count = counts[c.key];
    const officeSummary = official
      .map((o) => `${o.reachable ? `ok(${o.markersFound.length}m)` : `unreachable(${o.status})`}`)
      .join(", ");
    console.log(`  ${c.label.padEnd(8)} feed=${count}  official=[${officeSummary}]`);

    // P0: official page looks populated but our feed has 0.
    if (populated && count === 0) {
      alerts.push(`P0 ${c.label}: official Polymarket page populated but feed count = 0 (source coverage gap)`);
    }
  }

  for (const h of hazards) {
    alerts.push(`P0 hazard: ${h} present in production JSON`);
  }

  // 5) Verdict.
  console.log("\n--- Alerts ---");
  if (alerts.length === 0) {
    console.log("  none");
  } else {
    for (const a of alerts) console.log(`  ! ${a}`);
  }

  const fail = alerts.some((a) => a.startsWith("P0"));
  const verdict = fail ? "FAIL" : alerts.length > 0 ? "WARN" : "PASS";
  console.log(`\nVERDICT: ${verdict}`);
  console.log("=".repeat(60));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("Audit crashed:", err);
  process.exit(1);
});
