"use client";

import { useState } from "react";
import styles from "./Referral.module.css";

type ApiResult =
  | { ok: true; refCode: string; referralLink: string; status: "existing" | "created" }
  | { ok: false; error: string };

function isValidEmail(e: string) {
  return e.includes("@") && e.includes(".") && e.length <= 254;
}

const SHARE_TEXT =
  "I'm inviting you to join the PolyProPicks free-week invite list. Use my link to request access.";

export default function ReferralPage() {
  const [email, setEmail]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState("");
  const [result, setResult]         = useState<Extract<ApiResult, { ok: true }> | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) { setError("Please enter a valid email address."); return; }
    setLoading(true);
    try {
      const res  = await fetch("/api/referrals/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source: "referral_page" }),
      });
      const data: ApiResult = await res.json();
      if (!data.ok) { setError("Something went wrong. Please try again."); }
      else { setResult(data); }
    } catch { setError("Network error. Please try again."); }
    finally   { setLoading(false); }
  }

  async function copyLink() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.referralLink); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000); } catch {}
  }

  async function copyShare() {
    try { await navigator.clipboard.writeText(SHARE_TEXT); setCopiedShare(true); setTimeout(() => setCopiedShare(false), 2000); } catch {}
  }

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
            <a href="/reconstruction" className={styles.trustLink}>
              see latest resolved signals →
            </a>
          </span>
        </div>

        {/* Success module (shown after creation) */}
        {result && (
          <div className={styles.successCard}>
            <div className={styles.successHeader}>
              <div className={styles.successCheck}>✓</div>
              <span className={styles.successTitle}>Referral link created</span>
            </div>
            <p className={styles.successSub}>
              Share this invite with friends who want a free-week invite to PolyProPicks Premium.
            </p>

            <div className={styles.linkRow}>
              <span className={styles.linkText}>{result.referralLink}</span>
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

            <div className={styles.friendNote}>
              Your friend can join the free-week invite list through this link.
            </div>
          </div>
        )}

        {/* Action card — above fold, before ladder */}
        {!result && (
          <form className={styles.actionCard} onSubmit={handleSubmit}>
            <p className={styles.actionTitle}>Create your referral link</p>
            <p className={styles.actionSub}>Enter your email to generate a personal invite link.</p>
            <input
              className={styles.input}
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
            />
            {error && <p className={styles.errorText}>{error}</p>}
            <button className={styles.ctaBtn} type="submit" disabled={loading}>
              {loading ? "Creating link…" : "Create My Referral Link"}
            </button>
          </form>
        )}

        {/* Compact credit summary strip — visible just below CTA */}
        {!result && (
          <div className={styles.creditSummary}>
            <span className={styles.creditSummaryAmount}>$30 Premium Credit</span>
            <span className={styles.creditSummaryMid}>0 / 3 verified paid referrals</span>
            <span className={styles.creditSummaryNote}>Premium Credit only. Not cash. Not a bank card.</span>
          </div>
        )}

        {/* Full credit ladder — below fold */}
        <div className={styles.ladderCard}>
          <div className={styles.ladderTop}>
            <span className={styles.ladderLabel}>Premium Credit</span>
            <span className={styles.ladderPill}>Referral Ladder</span>
          </div>
          <p className={styles.ladderTitle}>$30 Premium Credit</p>
          <p className={styles.ladderProgress}>0 / 3 verified paid referrals</p>

          <div className={styles.ladderSteps}>
            <div className={styles.ladderStep}>
              <span className={styles.stepNum}>1</span>
              <span className={styles.stepText}>1 verified paid referral → $10 Premium Credit</span>
            </div>
            <div className={styles.ladderStep}>
              <span className={styles.stepNum}>2</span>
              <span className={styles.stepText}>2 verified paid referrals → $20 Premium Credit</span>
            </div>
            <div className={styles.ladderStep}>
              <span className={styles.stepNum}>3</span>
              <span className={styles.stepText}>3 verified paid referrals → $30 Premium Credit + Partner Program unlocked</span>
            </div>
          </div>

          <p className={styles.ladderNote}>Premium Credit only. Not cash. Not a bank card.</p>
        </div>

        {/* Terms */}
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
