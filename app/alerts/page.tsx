import type { Metadata } from "next";
import Link from "next/link";
import AlertsForm from "./AlertsForm";
import styles from "./Alerts.module.css";

export const metadata: Metadata = {
  title: "PolyProPicks Sports Market Analytics Alerts",
  description:
    "Subscribe to occasional PolyProPicks analytical briefing and product-access SMS updates.",
};

export default function AlertsPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <p className={styles.brand}>PolyProPicks</p>
        <p className={styles.eyebrow}>SMS ALERTS</p>
        <h1 className={styles.title}>
          Get PolyProPicks Sports Market Analytics Alerts
        </h1>
        <p className={styles.subtitle}>
          Receive occasional SMS notifications about analytical briefings,
          product-access updates and account-related information.
        </p>

        <AlertsForm />

        <p className={styles.support}>
          Questions?{" "}
          <Link
            href="mailto:alex_ceo@polypropicks.com"
            className={styles.supportLink}
          >
            alex_ceo@polypropicks.com
          </Link>
        </p>
      </div>
    </main>
  );
}
