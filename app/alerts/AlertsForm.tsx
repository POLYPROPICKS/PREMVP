"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";
import styles from "./Alerts.module.css";

type Status = "idle" | "submitting" | "success" | "no_phone" | "error";

export default function AlertsForm() {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [showConsentError, setShowConsentError] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Empty phone: no API call — show neutral message
    if (!phone.trim()) {
      setShowConsentError(false);
      setStatus("no_phone");
      return;
    }

    // Phone present: consent required before API call
    if (!consent) {
      setShowConsentError(true);
      return;
    }
    setShowConsentError(false);

    setStatus("submitting");

    try {
      const res = await fetch("/api/sms-opt-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, consent, companyWebsite }),
      });

      if (res.ok) {
        setStatus("success");
        setPhone("");
        setConsent(false);
        setCompanyWebsite("");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "no_phone") {
    return (
      <p className={`${styles.status} ${styles.success}`} role="status" aria-live="polite">
        Thank you. No SMS subscription was created because no mobile number was
        provided.
      </p>
    );
  }

  if (status === "success") {
    return (
      <p className={`${styles.status} ${styles.success}`} role="status" aria-live="polite">
        You&apos;re subscribed to PolyProPicks SMS alerts. Reply STOP at any
        time to unsubscribe.
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {/* Honeypot — visually hidden, off-screen */}
      <div className={styles.honeypot} aria-hidden="true">
        <label htmlFor="companyWebsite">Website</label>
        <input
          id="companyWebsite"
          name="companyWebsite"
          type="text"
          value={companyWebsite}
          onChange={(e) => setCompanyWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="phone" className={styles.label}>
          Mobile phone number
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+1 202 555 0147"
          value={phone}
          onChange={(e) => { setPhone(e.target.value); setShowConsentError(false); }}
          className={styles.input}
          disabled={status === "submitting"}
        />
      </div>

      <div className={styles.consentRow}>
        <input
          id="consent"
          name="consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => { setConsent(e.target.checked); setShowConsentError(false); }}
          className={styles.checkbox}
          disabled={status === "submitting"}
        />
        <div>
          <label htmlFor="consent" className={styles.disclosure}>
            I agree to receive recurring automated promotional text messages
            from PolyProPicks about analytical briefings and product-access
            updates. Consent is not a condition of purchase. Message frequency
            may vary, up to 2 messages per week. Message and data rates may
            apply. Reply STOP to unsubscribe. Reply HELP for help.
          </label>
          <p className={styles.legalLinks}>
            <Link href="/privacy-policy" className={styles.link}>
              Privacy Policy
            </Link>
            {" · "}
            <Link href="/terms-of-use" className={styles.link}>
              Terms of Use
            </Link>
          </p>
        </div>
      </div>

      {showConsentError && (
        <p className={styles.consentError} role="alert" aria-live="polite">
          Please check the consent box to subscribe to SMS alerts.
        </p>
      )}

      {status === "error" && (
        <p className={`${styles.status} ${styles.error}`} role="status" aria-live="polite">
          We could not save your subscription. Please try again or contact{" "}
          <a href="mailto:alex_ceo@polypropicks.com" className={styles.link}>
            alex_ceo@polypropicks.com
          </a>
          .
        </p>
      )}

      <button
        type="submit"
        className={styles.submit}
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "Subscribing..." : "Subscribe to SMS Alerts"}
      </button>
    </form>
  );
}
