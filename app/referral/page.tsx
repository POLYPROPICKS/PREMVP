"use client";

import { useState } from "react";
import styles from "./Referral.module.css";

// ── Types ──────────────────────────────────────────────────────────────────
type CreateResult = { ok: true; refCode: string; referralLink: string; status: "existing" | "created" };
type RecentReferral = { createdAt: string; emailMasked: string; source: string | null; status: string };
type Dashboard = {
  clickCount: number; referredLeadCount: number; pendingReferralCount: number;
  verifiedPaidReferralCount: number; premiumCreditUsd: number; maxPremiumCreditUsd: number;
  partnerUnlocked: boolean; recentReferrals: RecentReferral[];
  rewardStatus: string; disclaimer: string;
};
type StatusResult = { ok: true; hasReferralLink: boolean; refCode?: string; referralLink?: string; dashboard: Dashboard | null };

// ── Static leaderboard ────────────────────────────────────────────────────
const LEADERBOARD = [
  { name: "0xA7F3…9C2B", score: 28 }, { name: "0x91D4…7FA0", score: 24 },
  { name: "0xC8B1…44E9", score: 22 }, { name: "0x3F9A…B12D", score: 16 },
  { name: "0xE02C…8A71", score: 13 }, { name: "0x7B6E…D3F4", score: 11 },
  { name: "0xB4A9…20CE", score: 9  }, { name: "0x58D1…AF06", score: 7  },
  { name: "0xD93F…61B8", score: 5  }, { name: "0x12AC…E7D5", score: 4  },
];

// ── Helpers ───────────────────────────────────────────────────────────────
function isValidEmail(e: string) { return e.includes("@") && e.includes(".") && e.length <= 254; }
function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return "—"; }
}

const SHARE_TEXT = "I'm inviting you to join the PolyProPicks free-week invite list. Use my link to request access.";

// ── Main component ────────────────────────────────────────────────────────
export default function ReferralPage() {
  const [tab, setTab]                     = useState<"create" | "dashboard">("create");

  // Create flow
  const [createEmail, setCreateEmail]     = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError]     = useState("");
  const [createResult, setCreateResult]   = useState<CreateResult | null>(null);
  const [copiedLink, setCopiedLink]       = useState(false);
  const [copiedShare, setCopiedShare]     = useState(false);

  // Dashboard flow
  const [checkInput, setCheckInput]       = useState("");
  const [checkLoading, setCheckLoading]   = useState(false);
  const [checkError, setCheckError]       = useState("");
  const [dashboard, setDashboard]         = useState<Dashboard | null>(null);
  const [dashRefCode, setDashRefCode]     = useState<string | null>(null);
  const [dashLink, setDashLink]           = useState<string | null>(null);
  const [dashNotFound, setDashNotFound]   = useState(false);
  const [dashCopied, setDashCopied]       = useState(false);

  // ── Create handler ──────────────────────────────────────────────────────
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    const trimmed = createEmail.trim();
    if (!isValidEmail(trimmed)) { setCreateError("Please enter a valid email address."); return; }
    setCreateLoading(true);
    try {
      const res = await fetch("/api/referrals/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source: "referral_page" }),
      });
      const data = await res.json();
      if (!data.ok) { setCreateError("Something went wrong. Please try again."); return; }
      setCreateResult(data as CreateResult);
      // Auto-load dashboard for the new link
      await fetchDashboard({ refCode: (data as CreateResult).refCode, link: (data as CreateResult).referralLink });
      setTab("dashboard");
    } catch { setCreateError("Network error. Please try again."); }
    finally   { setCreateLoading(false); }
  }

  // ── Check dashboard handler ─────────────────────────────────────────────
  async function handleCheck(e: React.FormEvent) {
    e.preventDefault();
    setCheckError("");
    setDashNotFound(false);
    const raw = checkInput.trim();
    if (!raw) { setCheckError("Enter your email or referral code."); return; }
    setCheckLoading(true);
    const isEmail = raw.includes("@");
    const body = isEmail ? { email: raw } : { refCode: raw };
    await fetchDashboard(body);
    setCheckLoading(false);
  }

  async function fetchDashboard(body: { email?: string; refCode?: string; link?: string }) {
    const { link: preLink, ...apiBody } = body;
    try {
      const res = await fetch("/api/referrals/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiBody),
      });
      const data: StatusResult = await res.json();
      if (!data.ok) { setCheckError("Something went wrong. Please try again."); return; }
      if (!data.hasReferralLink || !data.dashboard) {
        setDashNotFound(true); setDashboard(null); return;
      }
      setDashboard(data.dashboard);
      setDashRefCode(data.refCode ?? null);
      setDashLink(data.referralLink ?? preLink ?? null);
    } catch { setCheckError("Network error. Please try again."); }
  }

  async function copyDashLink() {
    if (!dashLink) return;
    try { await navigator.clipboard.writeText(dashLink); setDashCopied(true); setTimeout(() => setDashCopied(false), 2000); } catch {}
  }
  async function copyLink() {
    if (!createResult) return;
    try { await navigator.clipboard.writeText(createResult.referralLink); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); } catch {}
  }
  async function copyShare() {
    try { await navigator.clipboard.writeText(SHARE_TEXT); setCopiedShare(true); setTimeout(() => setCopiedShare(false), 2000); } catch {}
  }

  const creditPct = dashboard ? Math.min((dashboard.verifiedPaidReferralCount / 3) * 100, 100) : 0;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        {/* Header */}
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.monogram}>PP</div>
            <span className={styles.brandName}>PolyProPicks</span>
          </div>
          <div className={styles.accessPill}>
            <span className={styles.accessDot} />
            Referral Access
          </div>
        </header>

        {/* Hero */}
        <div className={styles.hero}>
          <h1 className={styles.headline}>
            Get <span className={styles.headlineAccent}>$30 Premium Credit</span>
          </h1>
          <p className={styles.subheadline}>
            Give a friend a free week. Earn Premium Credit when referrals become paid subscribers.
          </p>
        </div>

        {/* Trust strip */}
        <div className={styles.trustStrip}>
          <span className={styles.trustIcon} />
          <span className={styles.trustText}>
            Signal results are updating ·{" "}
            <a href="/reconstruction" className={styles.trustLink}>see latest resolved signals →</a>
          </span>
        </div>

        {/* Segmented tabs */}
        <div className={styles.tabs}>
          <button className={tab === "create" ? styles.tabActive : styles.tabInactive}
            onClick={() => setTab("create")} type="button">Create Link</button>
          <button className={tab === "dashboard" ? styles.tabActive : styles.tabInactive}
            onClick={() => setTab("dashboard")} type="button">My Dashboard</button>
        </div>

        {/* ── CREATE TAB ──────────────────────────────────────── */}
        {tab === "create" && (
          <>
            {!createResult ? (
              <form className={styles.actionCard} onSubmit={handleCreate}>
                <p className={styles.actionTitle}>Create your referral link</p>
                <p className={styles.actionSub}>Enter your email to generate a personal invite link.</p>
                <input className={styles.input} type="email" placeholder="Email address"
                  value={createEmail} onChange={(e) => setCreateEmail(e.target.value)}
                  autoComplete="email" disabled={createLoading} />
                {createError && <p className={styles.errorText}>{createError}</p>}
                <button className={styles.ctaBtn} type="submit" disabled={createLoading}>
                  {createLoading ? "Creating link…" : "Create My Referral Link"}
                </button>
                <button className={styles.switchTabLink} type="button"
                  onClick={() => setTab("dashboard")}>Check existing dashboard instead →</button>
              </form>
            ) : (
              <div className={styles.successCard}>
                <div className={styles.successHeader}>
                  <div className={styles.successCheck}>✓</div>
                  <span className={styles.successTitle}>Referral link created</span>
                </div>
                <p className={styles.successSub}>Share this invite with friends who want a free-week invite to PolyProPicks Premium.</p>
                <div className={styles.linkRow}>
                  <span className={styles.linkText}>{createResult.referralLink}</span>
                  <button className={styles.copyInlineBtn} onClick={copyLink} type="button">
                    {copiedLink ? "Copied!" : "Copy"}
                  </button>
                </div>
                <div className={styles.shareBlock}>
                  <span className={styles.shareLabel}>Share text</span>
                  <div className={styles.shareTextBox}>{SHARE_TEXT}</div>
                  <button className={styles.copyShareBtn} onClick={copyShare} type="button">
                    {copiedShare ? "Copied!" : "Copy share text"}
                  </button>
                </div>
                <div className={styles.friendNote}>Your friend can join the free-week invite list through this link.</div>
              </div>
            )}

            {/* Credit ladder */}
            <div className={styles.ladderCard}>
              <div className={styles.ladderTop}>
                <span className={styles.ladderLabel}>Premium Credit</span>
                <span className={styles.ladderPill}>Referral Ladder</span>
              </div>
              <p className={styles.ladderTitle}>$30 Premium Credit</p>
              <p className={styles.ladderProgress}>0 / 3 verified paid referrals</p>
              <div className={styles.ladderSteps}>
                {[
                  "1 verified paid referral → $10 Premium Credit",
                  "2 verified paid referrals → $20 Premium Credit",
                  "3 verified paid referrals → $30 Premium Credit + Partner Program unlocked",
                ].map((txt, i) => (
                  <div className={styles.ladderStep} key={i}>
                    <span className={styles.stepNum}>{i + 1}</span>
                    <span className={styles.stepText}>{txt}</span>
                  </div>
                ))}
              </div>
              <p className={styles.ladderNote}>Premium Credit only. Not cash. Not a bank card.</p>
            </div>
          </>
        )}

        {/* ── DASHBOARD TAB ───────────────────────────────────── */}
        {tab === "dashboard" && (
          <>
            {!dashboard && !dashNotFound && (
              <form className={styles.actionCard} onSubmit={handleCheck}>
                <p className={styles.actionTitle}>Check your referrals</p>
                <p className={styles.actionSub}>Restore your dashboard by email or referral code.</p>
                <input className={styles.input} type="text" placeholder="Email or referral code"
                  value={checkInput} onChange={(e) => setCheckInput(e.target.value)}
                  autoComplete="email" disabled={checkLoading} />
                {checkError && <p className={styles.errorText}>{checkError}</p>}
                <button className={styles.ctaBtn} type="submit" disabled={checkLoading}>
                  {checkLoading ? "Checking…" : "Check My Dashboard"}
                </button>
                <button className={styles.switchTabLink} type="button"
                  onClick={() => setTab("create")}>Create a new link instead →</button>
              </form>
            )}

            {dashNotFound && (
              <div className={styles.notFoundCard}>
                <p className={styles.notFoundText}>No referral link found. Create your link first.</p>
                <button className={styles.switchTabLink} type="button"
                  onClick={() => { setDashNotFound(false); setTab("create"); }}>
                  Create a new link →
                </button>
              </div>
            )}

            {dashboard && (
              <div className={styles.dashCard}>
                <div className={styles.dashTop}>
                  <span className={styles.dashTitle}>Your Referral Dashboard</span>
                  {dashRefCode && <span className={styles.dashCode}>{dashRefCode}</span>}
                </div>

                {/* Link row */}
                {dashLink && (
                  <div className={styles.linkRow}>
                    <span className={styles.linkText}>{dashLink}</span>
                    <button className={styles.copyInlineBtn} onClick={copyDashLink} type="button">
                      {dashCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                )}

                {/* Stat tiles */}
                <div className={styles.statGrid}>
                  {[
                    { label: "Clicks",             value: dashboard.clickCount },
                    { label: "Referred leads",      value: dashboard.referredLeadCount },
                    { label: "Pending",             value: dashboard.pendingReferralCount },
                    { label: "Verified paid",       value: dashboard.verifiedPaidReferralCount },
                  ].map(({ label, value }) => (
                    <div className={styles.statTile} key={label}>
                      <span className={styles.statValue}>{value}</span>
                      <span className={styles.statLabel}>{label}</span>
                    </div>
                  ))}
                </div>

                {/* Credit progress */}
                <div className={styles.progressBlock}>
                  <div className={styles.progressTop}>
                    <span className={styles.progressLabel}>Premium Credit</span>
                    <span className={styles.progressAmount}>${dashboard.premiumCreditUsd} / $30</span>
                  </div>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${creditPct}%` }} />
                  </div>
                  <p className={styles.progressNote}>Partner unlock at 3 verified referrals · Premium Credit only · not cash</p>
                </div>

                {/* Recent referrals */}
                <div className={styles.recentBlock}>
                  <span className={styles.recentLabel}>Recent referrals</span>
                  {dashboard.recentReferrals.length === 0 ? (
                    <p className={styles.recentEmpty}>No referred leads yet. Share your link to start tracking activity.</p>
                  ) : (
                    <div className={styles.recentList}>
                      {dashboard.recentReferrals.map((r, i) => (
                        <div className={styles.recentRow} key={i}>
                          <span className={styles.recentEmail}>{r.emailMasked}</span>
                          <span className={styles.recentDate}>{fmtDate(r.createdAt)}</span>
                          <span className={styles.recentStatus}>{r.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <p className={styles.dashDisclaimer}>{dashboard.disclaimer}</p>
              </div>
            )}

            {/* Community leaderboard — always visible in dashboard tab */}
            <div className={styles.leaderCard}>
              <div className={styles.leaderTop}>
                <span className={styles.leaderTitle}>Top Referral Wallets · last 14 days</span>
                <span className={styles.demoLabel}>Live board</span>
              </div>
              <div className={styles.leaderList}>
                {LEADERBOARD.map((row, i) => (
                  <div className={styles.leaderRow} key={i}>
                    <span className={styles.leaderRank}>#{i + 1}</span>
                    <span className={styles.leaderName}>{row.name}</span>
                    <span className={styles.leaderScore}>{row.score} referrals</span>
                  </div>
                ))}
              </div>
              <p className={styles.leaderFooter}>Updated from referral activity</p>
            </div>
          </>
        )}

        {/* Terms — always visible */}
        <div className={styles.terms}>
          <p className={styles.termLine}>Rewards verify only after paid subscription confirmation.</p>
          <p className={styles.termLine}>Refunds, chargebacks and cancellations void rewards.</p>
          <p className={styles.termLine}>Partner access requires manual approval.</p>
          <p className={styles.termLine}>Signals are probabilistic, not guaranteed outcomes.</p>
        </div>

      </div>
    </div>
  );
}
