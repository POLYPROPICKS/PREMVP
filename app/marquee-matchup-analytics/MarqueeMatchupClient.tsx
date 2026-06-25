"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./MarqueeMatchup.module.css";

// ---- Types (subset of /api/feed/landing-cards response) ----
interface ApiPair {
  premiumSignal?: { league?: string; eventTitle?: string; positionDisplay?: string };
  diagnostics?: {
    gameStartIso?: string | null;
    parentEventVolume24hr?: number | null;
    signalStatus?: string;
  };
}

interface MarqueeMatchup {
  key: string;
  league: string; // display league label (WC2026 / NBA / NHL / Esports / Soccer)
  title: string; // clean physical matchup: "Team A vs Team B"
  timeLabel: string;
  iconKey: IconKey;
}

type IconKey = "basketball" | "hockey" | "soccer" | "esports" | "default";

// ---- Local dev fallback (used only when no clean live matchup is available) ----
const FALLBACK: MarqueeMatchup[] = [
  { key: "f1", league: "NBA", title: "Lakers vs Warriors", timeLabel: "Today · 8:30 PM ET", iconKey: "basketball" },
  { key: "f2", league: "NHL", title: "Rangers vs Bruins", timeLabel: "Today · 7:00 PM ET", iconKey: "hockey" },
  { key: "f3", league: "WC2026", title: "Spain vs Italy", timeLabel: "Tomorrow · 3:00 PM ET", iconKey: "soccer" },
];

// Classify a clean matchup into a display league label + sport icon.
// Generic "Sports" bucket in this feed is national-team soccer (World Cup markets),
// so it maps to WC2026 rather than the calendar fallback.
function classify(league: string, a: string, b: string): { label: string; icon: IconKey } {
  const t = `${league} ${a} ${b}`.toLowerCase();
  if (/\b(nba|wnba|basketball)\b/.test(t)) return { label: "NBA", icon: "basketball" };
  if (/\b(nhl|hockey)\b/.test(t)) return { label: "NHL", icon: "hockey" };
  if (/(esport|valorant|league of legends|\blol\b|dota|cs2|csgo|cs:go)/.test(t)) return { label: "Esports", icon: "esports" };
  if (/(world cup|wc2026|fifa|national team)/.test(t)) return { label: "WC2026", icon: "soccer" };
  // Named domestic club competitions stay generic football.
  if (/(premier|laliga|la liga|serie a|bundesliga|champions league|\bepl\b|\bmls\b|ligue 1)/.test(t)) return { label: "Soccer", icon: "soccer" };
  // This feed's generic "Sports"/"Soccer" bucket is national-team football (World Cup markets),
  // so prefer the WC2026 label over a weak generic "Soccer" when no club league is named.
  if (/\b(sports?|soccer|football)\b/.test(t)) return { label: "WC2026", icon: "soccer" };
  const label = league ? league.replace(/\s+/g, " ").trim() : "Marquee Matchup";
  return { label, icon: "default" };
}

// Compliance guard — runs on the FINAL displayed text (clean matchup + league),
// not on raw market titles. Skips anything reading as a wager/market line.
const FORBIDDEN_DISPLAY = /\b(winner|winners|win|winning|match winner|moneyline|spread|handicap|total|totals|over|under|o\/u|odds|pick|picks|bet|betting|wager|profit|roi|returns|signals?|edge|lock|trade|trading|prediction market|polymarket|kalshi|sharp|whale|capper|parlay|line movement)\b/i;
const FORBIDDEN_LINE = /([+-]\d+(?:\.\d+)?\b|\bo\/u\b)/i;

function isDisplaySafe(text: string): boolean {
  return !FORBIDDEN_DISPLAY.test(text) && !FORBIDDEN_LINE.test(text);
}

// Title-case-safe team cleanup: drop parenthetical line annotations + trailing truncation.
function cleanTeam(s: string): string {
  return s
    .replace(/\(.*?\)/g, " ")
    .replace(/[.…]{2,}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Derive a real physical matchup ("Team A vs Team B") from raw market title + selected side.
// Returns null when no reliable two-sided matchup can be built (e.g. one-sided moneyline).
function deriveMatchup(rawTitle: string, positionDisplay: string): { a: string; b: string } | null {
  let t = rawTitle.trim();
  if (!t) return null;

  // Pattern A — explicit "A vs B" / "A vs. B" embedded in the title.
  if (/\bvs\.?\b/i.test(t)) {
    // strip a leading sport/tournament prefix without a dot, e.g. "Valorant: " / "Esports: "
    let body = t.replace(/^[A-Za-z0-9 ]{1,18}:\s*/, "");
    // strip a trailing market descriptor, e.g. ": O/U 2.5", ": Spread", ": Total", ": 2.5"
    body = body.replace(/:\s*(o\/u|over\/under|totals?|spread|moneyline|match|line|[\d.]).*$/i, "");
    const m = body.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (m) {
      const a = cleanTeam(m[1]);
      const b = cleanTeam(m[2]);
      if (a && b && a.toLowerCase() !== b.toLowerCase()) return { a, b };
    }
  }

  // Pattern B — "Spread: TEAM (line)" reconstructed with the opposing selected side.
  const sp = t.match(/spread:\s*(.+?)\s*\(/i);
  if (sp) {
    const a = cleanTeam(sp[1]);
    const b = cleanTeam(positionDisplay || "");
    if (a && b && a.toLowerCase() !== b.toLowerCase() && !/^(over|under|yes|no)$/i.test(b)) {
      return { a, b };
    }
  }

  return null; // one-sided moneyline / unparseable → skip
}

// Order-independent physical-event key: collapses O/U + spread + moneyline of the
// same match, and "A vs B" / "B vs A", into one row.
function matchupKey(a: string, b: string): string {
  return [a, b]
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ""))
    .sort()
    .join("|");
}

function formatEt(iso: string | null | undefined): string {
  if (!iso) return "Upcoming";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "Upcoming";

  const tz = "America/New_York";
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });

  const dayKey = (d: Date) => dayFmt.format(d);
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const time = `${timeFmt.format(date)} ET`;
  if (dayKey(date) === dayKey(now)) return `Today · ${time}`;
  if (dayKey(date) === dayKey(tomorrow)) return `Tomorrow · ${time}`;

  const compact = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(date);
  return `${compact} · ${time}`;
}

function selectMarqueeMatchups(pairs: ApiPair[]): MarqueeMatchup[] {
  const best = new Map<string, { game: MarqueeMatchup; volume: number }>();

  for (const pair of pairs) {
    const league = String(pair.premiumSignal?.league ?? "").trim();
    const rawTitle = String(pair.premiumSignal?.eventTitle ?? "").trim();
    const positionDisplay = String(pair.premiumSignal?.positionDisplay ?? "").trim();
    if (!rawTitle) continue;

    const matchup = deriveMatchup(rawTitle, positionDisplay);
    if (!matchup) continue; // no reliable two-sided physical event → skip

    const { label, icon } = classify(league, matchup.a, matchup.b);
    const title = `${matchup.a} vs ${matchup.b}`;
    if (!isDisplaySafe(`${label} ${title}`)) continue; // compliance gate on displayed text

    const key = matchupKey(matchup.a, matchup.b);
    const volume = Number(pair.diagnostics?.parentEventVolume24hr ?? 0);
    const game: MarqueeMatchup = {
      key,
      league: label,
      title,
      timeLabel: formatEt(pair.diagnostics?.gameStartIso),
      iconKey: icon,
    };

    const prev = best.get(key);
    if (!prev || volume > prev.volume) best.set(key, { game, volume });
  }

  return Array.from(best.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3)
    .map((e) => e.game);
}

// ---- Icons (inline SVG, no official logos) ----
function GameIcon({ kind }: { kind: IconKey }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  switch (kind) {
    case "basketball":
      return (
        <svg {...common} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3v18M5.5 5.5C9 8 9 16 5.5 18.5M18.5 5.5C15 8 15 16 18.5 18.5" /></svg>
      );
    case "hockey":
      return (
        <svg {...common} aria-hidden="true"><path d="M4 5v8a5 4 0 0 0 10 0" /><ellipse cx="18" cy="17" rx="3" ry="1.4" /></svg>
      );
    case "soccer":
      return (
        <svg {...common} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8l3 2-1 3.5h-4L9 10z" /><path d="M12 8V4.5M15 10l3.2-1.2M14 13.5l2.2 2.8M10 13.5l-2.2 2.8M9 10L5.8 8.8" /></svg>
      );
    case "esports":
      return (
        <svg {...common} aria-hidden="true"><rect x="2.5" y="7" width="19" height="10" rx="3" /><path d="M7 10v4M5 12h4M15.5 11.5h.01M18 13.5h.01" /></svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9h17M8 3v4M16 3v4" /></svg>
      );
  }
}

const ARROW = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

export default function MarqueeMatchupClient() {
  const [games, setGames] = useState<MarqueeMatchup[] | null>(null);

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const res = await fetch(
          "/api/feed/landing-cards?limit=15&category=sports&minDataCoverage=40&excludeEnded=true&includeUpcoming=true"
        );
        if (!res.ok) throw new Error("feed");
        const data = await res.json();
        const pairs: ApiPair[] = [
          ...(Array.isArray(data?.pairs) ? data.pairs : []),
          ...(Array.isArray(data?.upcomingPairs) ? data.upcomingPairs : []),
        ];
        const selected = selectMarqueeMatchups(pairs);
        if (active) setGames(selected.length >= 1 ? selected : FALLBACK);
      } catch {
        if (active) setGames(FALLBACK);
      }
    };
    run();
    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => games ?? FALLBACK, [games]);

  return (
    <main className={styles.page}>
      <div className={styles.atmosphere} aria-hidden="true" />
      <div className={styles.grid} aria-hidden="true" />
      <div className={styles.vignette} aria-hidden="true" />

      <section className={styles.modal} role="dialog" aria-label="Marquee Matchup Analytics preview">
        <Link href="/" className={styles.close} aria-label="Close preview">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </Link>

        <header className={styles.header}>
          <span className={styles.logoMark} aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2l8.5 5v10L12 22 3.5 17V7z" /><path d="M9 8.5h4.2a2.3 2.3 0 0 1 0 4.6H9V16M9 8.5V16" /></svg>
          </span>
          <div>
            <p className={styles.brand}>PolyProPicks</p>
            <p className={styles.kicker}>Marquee Matchup Analytics</p>
          </div>
        </header>

        <h1 className={styles.hero}>Your marquee matchup analytics are ready</h1>
        <p className={styles.sub}>
          Game-day context and event activity summaries in one concise preview.
        </p>

        <div className={styles.previewTitle}>
          <span className={styles.star} aria-hidden="true">★</span>
          <span>Today&apos;s Marquee Matchups</span>
        </div>

        <ul className={styles.cards}>
          {rows.map((g) => (
            <li key={g.key} className={styles.card}>
              <span className={`${styles.icon} ${styles[`icon_${g.iconKey}`] ?? ""}`}>
                <GameIcon kind={g.iconKey} />
              </span>
              <div className={styles.cardBody}>
                <p className={styles.cardTitle}>
                  <span className={styles.league}>{g.league}</span>
                  <span className={styles.dot}>·</span>
                  {g.title}
                </p>
                <p className={styles.cardTime}>{g.timeLabel}</p>
                <p className={styles.status}>
                  <span className={styles.greenDot} aria-hidden="true" />
                  Analytics available
                </p>
              </div>
              <span className={styles.chev} aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6l6 6-6 6" /></svg>
              </span>
            </li>
          ))}
        </ul>

        <Link href="/?source=sms_marquee_matchup_analytics" className={styles.cta}>
          <span>View Matchup Analytics</span>
          {ARROW}
        </Link>
        <p className={styles.microcopy}>Takes under a minute.</p>

        <div className={styles.benefits}>
          <div className={styles.benefit}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9h17M8 3v4M16 3v4" /></svg>
            <span>Game-day context</span>
          </div>
          <div className={styles.benefit}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 18l5-5 3 3 6-7M16 9h3v3" /></svg>
            <span>Activity summaries</span>
          </div>
          <div className={styles.benefit}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="9" r="3.2" /><path d="M5.5 19a6.5 6.5 0 0 1 13 0" /></svg>
            <span>Member access updates</span>
          </div>
        </div>

        <footer className={styles.footer}>
          <p>PolyProPicks is operated by Benefitpoint Alexander Grushin.</p>
          <p>
            Support:{" "}
            <a href="mailto:alex_ceo@polypropicks.com" className={styles.flink}>
              alex_ceo@polypropicks.com
            </a>
          </p>
          <p className={styles.compliance}>Reply HELP for help. Reply STOP to opt out.</p>
        </footer>
      </section>
    </main>
  );
}
