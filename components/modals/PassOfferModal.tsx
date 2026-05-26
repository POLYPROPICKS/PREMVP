'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import styles from './PassOfferModal.module.css';
import SignalWeekResultsCard from '../signal-week-results/SignalWeekResultsCard';
import type { WeekResultsCard } from '../signal-week-results/types';

type InternalPlanId = 'premium_7day_weekly' | 'premium_monthly';

function toInternalPlanId(planId: PlanId): InternalPlanId | null {
  if (planId === '7day') return 'premium_7day_weekly';
  if (planId === 'monthly') return 'premium_monthly';
  return null;
}

function generateLeadIntentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-' + Date.now().toString().padStart(12, '0').slice(-12);
}

type PlanId = '7day' | '3day' | 'monthly';
type ViewState = 'offer' | 'reserve' | 'reserved';

interface PassOfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReserve: (planId: PlanId) => void;
  onPremiumReserve: (data: {
    email: string;
    planId: PlanId;
    planName: string;
    planPrice: string;
  }) => void;
}

const plans: Array<{
  id: PlanId;
  name: string;
  subtitle: string;
  helper?: string;
  price: string;
  perDay?: string;
  badge?: string;
}> = [
  {
    id: '7day',
    name: '7-Day Premium',
    subtitle: 'Full week of live signals',
    price: '$15',
    perDay: '$2.14/day',
    badge: 'BEST FOR YOU',
  },
  {
    id: 'monthly',
    name: 'Monthly Pro',
    subtitle: 'Best for daily market users',
    price: '$49',
    perDay: '$1.63/day',
  },
];

function getPlan(planId: PlanId) {
  return plans.find((plan) => plan.id === planId) ?? plans[0];
}

export default function PassOfferModal({ isOpen, onClose, onReserve, onPremiumReserve }: PassOfferModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>('7day');
  const [currentView, setCurrentView] = useState<ViewState>('offer');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [weekCard, setWeekCard] = useState<WeekResultsCard | null>(null);
  const [weekCardLoading, setWeekCardLoading] = useState(false);

  const currentPlan = useMemo(() => getPlan(selectedPlan), [selectedPlan]);

  const resetAndClose = useCallback(() => {
    setCurrentView('offer');
    setEmail('');
    setEmailError('');
    setIsSubmitting(false);
    setCheckoutLoading(false);
    setCheckoutError(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetAndClose();
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, resetAndClose]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setCurrentView('offer');
      setEmail('');
      setEmailError('');
      setIsSubmitting(false);
      setCheckoutLoading(false);
      setCheckoutError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (weekCard) return;
    setWeekCardLoading(true);
    fetch('/api/signals/resolved?mode=latest&days=7&limit=7')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const card = json?.weekResultsCard;
        if (card?.cardType === 'signal-week-results') {
          setWeekCard(card as WeekResultsCard);
        }
      })
      .catch(() => {})
      .finally(() => setWeekCardLoading(false));
  }, [isOpen, weekCard]);

  if (!isOpen) return null;

  const primaryCta = `Unlock ${currentPlan.name} — ${currentPlan.price}`;

  const handleSubmitReserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setEmailError('Enter a valid email to continue.');
      return;
    }

    const internalPlanId = toInternalPlanId(selectedPlan);
    if (!internalPlanId) {
      setCheckoutError('This pass is not available yet. Choose 7-Day Premium or Monthly Pro.');
      return;
    }

    if (checkoutLoading) return;

    setCheckoutLoading(true);
    setCheckoutError(null);
    setEmailError('');

    try {
      const leadIntentId = generateLeadIntentId();
      const response = await fetch('/api/checkout/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          internalPlanId,
          leadIntentId,
          source: 'pass_offer_modal',
          email: normalizedEmail,
        }),
      });

      const json = await response.json().catch(() => ({}));

      if (response.ok && typeof json.checkoutUrl === 'string' && json.checkoutUrl.length > 0) {
        window.location.href = json.checkoutUrl;
        return;
      }

      throw new Error('no_checkout_url');
    } catch {
      setCheckoutError('Checkout could not be started. Please try again.');
    } finally {
      setCheckoutLoading(false);
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Premium pass offer">
      <div className={styles.shell}>
        <div className={styles.backdropSignal} aria-hidden="true" />

        <header className={styles.topBar}>
          {currentView === 'offer' ? (
            <div className={styles.livePill}>
              <span className={styles.liveDot} />
              <span>LIVE EDGE LOCKED</span>
            </div>
          ) : (
            <button type="button" className={styles.backButton} onClick={() => setCurrentView('offer')}>
              ‹ Back to pricing
            </button>
          )}

          <button type="button" className={styles.closeButton} onClick={resetAndClose} aria-label="Close premium offer">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {currentView === 'offer' ? (
          <main className={styles.offerView}>
            <section className={styles.hero}>
              <h1 className={styles.heroTitle}>
                <span>Live edge is moving.</span>
                <span>The next signal is locked.</span>
              </h1>
            </section>

            <section className={styles.chartCard} aria-label="Past 7 days signal chart">
              <SignalWeekResultsCard data={weekCard} loading={weekCardLoading} variant="compact" />
            </section>

            <section className={styles.benefits} aria-label="Premium benefits">
              <div><span />ENTER · SKIP · WAIT per market</div>
              <div><span />Signals 2–4h before odds move</div>
              <div><span />Injury + lineup risk layer</div>
              <div><span />Live Polymarket whale-flow evidence</div>
              <div><span />Sharp market consensus checks</div>
            </section>

            <section className={styles.plans} aria-label="Select premium plan">
              {plans.map((plan) => {
                const isSelected = selectedPlan === plan.id;

                return (
                  <button
                    key={plan.id}
                    type="button"
                    className={`${styles.planCard} ${isSelected ? styles.selectedPlan : ''}`}
                    onClick={() => setSelectedPlan(plan.id)}
                    aria-pressed={isSelected}
                  >
                    <span className={styles.radio} aria-hidden="true">
                      {isSelected ? '✓' : ''}
                    </span>

                    <span className={styles.planCopy}>
                      {plan.badge && <span className={styles.planBadge}>{plan.badge}</span>}
                      <span className={styles.planName}>{plan.name}</span>
                      <span className={styles.planSubtitle}>{plan.subtitle}</span>
                      {plan.helper && <span className={styles.planHelper}>◷ {plan.helper}</span>}
                    </span>

                    <span className={styles.priceBlock}>
                      <strong>{plan.price}</strong>
                      {plan.perDay && <span>{plan.perDay}</span>}
                    </span>
                  </button>
                );
              })}
            </section>

            <section className={styles.actionArea}>
              <button type="button" className={styles.primaryCta} onClick={() => setCurrentView('reserve')}>
                {primaryCta}
              </button>
            </section>
          </main>
        ) : currentView === 'reserve' ? (
          <main className={styles.reserveView}>
            <section className={styles.reserveCard}>
              <div className={styles.reserveLock} aria-hidden="true">✓</div>
              <h2>Unlock your premium access</h2>
              <p>
                Enter your email to proceed to secure checkout. You'll get instant access after payment.
              </p>
              <form onSubmit={handleSubmitReserve} className={styles.reserveForm}>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  className={styles.emailInput}
                  disabled={checkoutLoading}
                  aria-label="Email address"
                />
                {emailError && <div className={styles.emailError}>{emailError}</div>}
                {checkoutError && <div className={styles.emailError}>{checkoutError}</div>}
                <button type="submit" className={styles.primaryCta} disabled={checkoutLoading}>
                  {checkoutLoading ? 'Starting checkout…' : `Unlock ${currentPlan.name} — ${currentPlan.price}`}
                </button>
              </form>
              <button type="button" className={styles.secondaryLink} onClick={() => setCurrentView('offer')}>
                Back to pricing
              </button>
              <p className={styles.legalText}>
                You will be taken to a secure Whop checkout page.
              </p>
            </section>
          </main>
        ) : (
          <main className={styles.reserveView}>
            <section className={styles.reserveCard}>
              <div className={styles.reserveLock} aria-hidden="true">✓</div>
              <h2>Premium access reserved</h2>
              <p>We saved your request. We'll notify you as soon as to pass opens.</p>
              <button type="button" className={styles.primaryCta} onClick={resetAndClose}>
                Back to free signal
              </button>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}
