'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import styles from './CheckoutComplete.module.css';

type EntitlementResult = {
  hasPremiumAccess: boolean;
  status: string;
  activePlan: string | null;
  accessUntil: string | null;
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function CheckoutCompletePage() {
  return (
    <Suspense>
      <CheckoutCompleteInner />
    </Suspense>
  );
}

function CheckoutCompleteInner() {
  const searchParams = useSearchParams();

  const rawStatus = (searchParams.get('status') ?? '').toLowerCase();
  const checkoutSessionId =
    searchParams.get('checkoutSessionId') ?? searchParams.get('session') ?? null;

  const isCancelled =
    rawStatus === 'cancelled' ||
    rawStatus === 'canceled' ||
    rawStatus === 'failure' ||
    rawStatus === 'failed';

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<EntitlementResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkBySessionId(sessionId: string) {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/entitlement/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutSessionId: sessionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        setResult({
          hasPremiumAccess: json.hasPremiumAccess,
          status: json.status,
          activePlan: json.activePlan ?? null,
          accessUntil: json.accessUntil ?? null,
        });
      } else {
        setError('Could not verify access. Enter your email below.');
      }
    } catch {
      setError('Could not verify access. Enter your email below.');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (checkoutSessionId && !isCancelled) {
      checkBySessionId(checkoutSessionId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleEmailCheck(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError('');
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/entitlement/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalized }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        setResult({
          hasPremiumAccess: json.hasPremiumAccess,
          status: json.status,
          activePlan: json.activePlan ?? null,
          accessUntil: json.accessUntil ?? null,
        });
      } else {
        setError('Access check failed. Please try again.');
      }
    } catch {
      setError('Access check failed. Please try again.');
    } finally {
      setChecking(false);
    }
  }

  // ── Result card ──────────────────────────────────────────────────────────
  if (result) {
    if (result.hasPremiumAccess) {
      return (
        <div className={styles.page}>
          <div className={styles.card}>
            <span className={styles.icon} aria-hidden="true">✓</span>
            <h1 className={styles.title}>Premium access confirmed</h1>
            <p className={styles.body}>Your PolyProPicks Premium access is active.</p>
            {result.accessUntil && (
              <p className={styles.secondary}>
                Access active until: {formatDate(result.accessUntil)}
              </p>
            )}
            <a href="/" className={styles.cta}>Go to PolyProPicks</a>
            <p className={styles.compliance}>
              Sports market intelligence is informational only. No guarantee of results.
            </p>
          </div>
        </div>
      );
    }

    if (result.status === 'expired') {
      return (
        <div className={styles.page}>
          <div className={styles.card}>
            <span className={styles.icon} aria-hidden="true">✕</span>
            <h1 className={styles.title}>Access expired</h1>
            <p className={styles.body}>This premium access is no longer active.</p>
            <a href="/" className={styles.cta}>Return to PolyProPicks</a>
            <p className={styles.compliance}>
              Sports market intelligence is informational only. No guarantee of results.
            </p>
          </div>
        </div>
      );
    }

    if (result.status === 'not_found') {
      return (
        <div className={styles.page}>
          <div className={styles.card}>
            <span className={styles.icon} aria-hidden="true">⟳</span>
            <h1 className={styles.title}>Access is still processing</h1>
            <p className={styles.body}>
              Whop may still be confirming your membership. Wait a minute and check again using the same email.
            </p>
            <EntitlementForm
              email={email}
              setEmail={setEmail}
              emailError={emailError}
              checking={checking}
              apiError={error}
              onSubmit={handleEmailCheck}
              onRetry={() => setResult(null)}
              styles={styles}
            />
            <p className={styles.compliance}>
              Sports market intelligence is informational only. No guarantee of results.
            </p>
          </div>
        </div>
      );
    }

    // inactive / unknown
    return (
      <div className={styles.page}>
        <div className={styles.card}>
          <span className={styles.icon} aria-hidden="true">⟳</span>
          <h1 className={styles.title}>Access not active yet</h1>
          <p className={styles.body}>
            If you just completed checkout, wait a minute and try again.
          </p>
          <EntitlementForm
            email={email}
            setEmail={setEmail}
            emailError={emailError}
            checking={checking}
            apiError={error}
            onSubmit={handleEmailCheck}
            onRetry={() => setResult(null)}
            styles={styles}
          />
          <p className={styles.compliance}>
            Sports market intelligence is informational only. No guarantee of results.
          </p>
        </div>
      </div>
    );
  }

  // ── Default / initial view ────────────────────────────────────────────────
  const title = isCancelled
    ? 'Checkout not completed'
    : checking
    ? 'Verifying access…'
    : 'Checkout received';

  const icon = isCancelled ? '✕' : '✓';

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true">{icon}</span>
        <h1 className={styles.title}>{title}</h1>

        {isCancelled ? (
          <>
            <p className={styles.body}>No access was activated.</p>
            <a href="/" className={styles.cta}>Return to PolyProPicks</a>
          </>
        ) : checking ? (
          <p className={styles.secondary}>Checking your access…</p>
        ) : (
          <>
            <p className={styles.body}>
              Your payment is being processed. Premium access will activate
              automatically once Whop confirms your membership.
            </p>
            {error && <p className={styles.checkError}>{error}</p>}
            <p className={styles.secondary}>Verify your premium access:</p>
            <EntitlementForm
              email={email}
              setEmail={setEmail}
              emailError={emailError}
              checking={checking}
              apiError={null}
              onSubmit={handleEmailCheck}
              styles={styles}
            />
          </>
        )}

        <p className={styles.compliance}>
          Sports market intelligence is informational only. No guarantee of results.
        </p>
      </div>
    </div>
  );
}

// ── Inline sub-component — avoids code duplication ────────────────────────
type FormProps = {
  email: string;
  setEmail: (v: string) => void;
  emailError: string;
  checking: boolean;
  apiError: string | null;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onRetry?: () => void;
  styles: Record<string, string>;
};

function EntitlementForm({
  email, setEmail, emailError, checking, apiError, onSubmit, onRetry, styles,
}: FormProps) {
  return (
    <form onSubmit={onSubmit} className={styles.checkForm}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Enter the email used at checkout"
        className={styles.checkInput}
        disabled={checking}
        aria-label="Email address"
      />
      {emailError && <p className={styles.checkError}>{emailError}</p>}
      {apiError && <p className={styles.checkError}>{apiError}</p>}
      <button type="submit" className={styles.cta} disabled={checking}>
        {checking ? 'Checking…' : 'Check access'}
      </button>
      {onRetry && (
        <button type="button" className={styles.secondaryLink} onClick={onRetry}>
          Try again
        </button>
      )}
    </form>
  );
}
