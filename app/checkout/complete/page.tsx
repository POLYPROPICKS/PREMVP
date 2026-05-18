import styles from "./CheckoutComplete.module.css";

type CheckoutCompleteSearchParams = {
  status?: string | string[];
  checkoutSessionId?: string | string[];
  session?: string | string[];
  plan?: string | string[];
};

type Props = {
  searchParams: Promise<CheckoutCompleteSearchParams>;
};

export default async function CheckoutCompletePage({ searchParams }: Props) {
  const params = await searchParams;

  const rawStatus =
    typeof params["status"] === "string" ? params["status"].toLowerCase() : "";

  const isCancelled =
    rawStatus === "cancelled" ||
    rawStatus === "canceled" ||
    rawStatus === "failure" ||
    rawStatus === "failed";

  const isSuccess = rawStatus === "success";

  const title = isCancelled
    ? "Checkout not completed"
    : isSuccess
    ? "Checkout successful"
    : "Checkout received";

  const icon = isCancelled ? "✕" : "✓";

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>

        <h1 className={styles.title}>{title}</h1>

        {isCancelled ? (
          <p className={styles.body}>No access was activated.</p>
        ) : (
          <>
            <p className={styles.body}>
              Your payment is being processed. Premium access will activate
              automatically once Whop confirms your membership.
            </p>
            <p className={styles.secondary}>
              You can return to PolyProPicks now. If access is not active yet,
              refresh in a minute.
            </p>
          </>
        )}

        <a href="/" className={styles.cta}>
          Return to PolyProPicks
        </a>

        <p className={styles.compliance}>
          Sports market intelligence is informational only.
          No guarantee of results.
        </p>
      </div>
    </div>
  );
}
