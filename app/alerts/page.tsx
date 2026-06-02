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
          Receive occasional promotional SMS notifications about PolyProPicks
          analytical briefings and product-access updates.
        </p>

        <AlertsForm />

        <p className={styles.support}>Customer support:</p>
        <p className={styles.support}>
          <Link
            href="mailto:alex_ceo@polypropicks.com"
            className={styles.supportLink}
          >
            alex_ceo@polypropicks.com
          </Link>
        </p>
        <p className={styles.support}>
          <a href="tel:+48793127374" className={styles.supportLink}>
            +48 793 127 374
          </a>
        </p>
        <p className={styles.support}>
          PolyProPicks is operated by Benefitpoint Alexander Grushin.
        </p>
      </div>
    </main>
  );
}
