'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import styles from './PassOfferModal.module.css';
import { trackClientEvent, getDistinctId } from '@/lib/analytics/posthogClient';
import { PPP_EVENTS, planSwitchEvents } from '@/lib/analytics/events';
import { DISTINCT_ID_HEADER } from '@/lib/analytics/identity';
import SignalWeekResultsCard from '../signal-week-results/SignalWeekResultsCard';
import type { WeekResultsCard } from '../signal-week-results/types';
import { selectHomepageTopTrustCard } from '@/lib/track-record/promotionalTrustGate';

const BENEFITS: string[] = [
  'Signals 2–4h before odds move',
  'Live Polymarket whale-flow evidence',
  'Injury + lineup risk layer',
  'Sharp market consensus checks',
  'ENTER · SKIP · WAIT per market',
];

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
  /** Gated proof card already selected by the host page — when provided, the
   *  modal renders the SAME card as the page's top proof card and never
   *  fetches an independent resolved source. */
  proofCard?: WeekResultsCard | null;
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

export default function PassOfferModal({ isOpen, proofCard, onClose, onReserve, onPremiumReserve }: PassOfferModalProps) {
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
    trackClientEvent(PPP_EVENTS.PAYWALL_CLOSE, { plan: selectedPlan, view: currentView });
    setCurrentView('offer');
    setEmail('');
    setEmailError('');
    setIsSubmitting(false);
    setCheckoutLoading(false);
    setCheckoutError(null);
    onClose();
  }, [onClose, selectedPlan, currentView]);

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
      trackClientEvent(PPP_EVENTS.PAYWALL_VIEW);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (weekCard) return;
    // When the host page already selected a gated proof card, reuse it so the
    // paywall and top card always show the SAME proof data — no independent
    // resolved fetch, no chance of divergent aggregates.
    if (proofCard) {
      setWeekCard(proofCard);
      return;
    }
    setWeekCardLoading(true);
    fetch('/api/signals/resolved?mode=latest&days=7&limit=7')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        // Promotional trust gate: only the curated legacy 7D proof card is
        // eligible, and only when its headline matches its own rows and it
        // clears the >=60% winners / non-negative PnL gate. The broad
        // read-model weekResultsCard aggregate is never shown here.
        const legacyCard: WeekResultsCard | null =
          json?.legacyWeekResultsCard?.cardType === 'signal-week-results'
            ? (json.legacyWeekResultsCard as WeekResultsCard)
            : null;
        const card = selectHomepageTopTrustCard({
          legacyCard,
          weekResultsCardTemplate: null,
          curatedSignals: [],
        });
        if (card) {
          setWeekCard(card);
        }
      })
      .catch(() => {})
      .finally(() => setWeekCardLoading(false));
  }, [isOpen, weekCard, proofCard]);

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
      // Identity stitching: pass the browser PostHog distinct id so the server
      // checkout events land on the same person. Fail-open if analytics blocked.
      const distinctId = getDistinctId();
      const response = await fetch('/api/checkout/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(distinctId ? { [DISTINCT_ID_HEADER]: distinctId } : {}),
        },
        body: JSON.stringify({
          internalPlanId,
          leadIntentId,
          source: 'pass_offer_modal',
          email: normalizedEmail,
          ...(distinctId ? { analyticsDistinctId: distinctId } : {}),
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
              <SignalWeekResultsCard data={weekCard} loading={weekCardLoading} variant="paywall" />
            </section>

            <section className={styles.plans} aria-label="Select premium plan">
              {plans.map((plan) => {
                const isSelected = selectedPlan === plan.id;

                return (
                  <button
                    key={plan.id}
                    type="button"
                    className={`${styles.planCard} ${isSelected ? styles.selectedPlan : ''}`}
                    onClick={() => {
                      const previousPlan = selectedPlan;
                      setSelectedPlan(plan.id);
                      // Pure helper decides selection vs switch (tested).
                      for (const ev of planSwitchEvents(previousPlan, plan.id)) {
                        trackClientEvent(
                          ev,
                          ev === PPP_EVENTS.PLAN_SWITCH
                            ? { from_plan: previousPlan, to_plan: plan.id }
                            : { plan: plan.id }
                        );
                      }
                    }}
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

            <section className={styles.benefitsList} aria-label="Premium benefits">
              <div className={styles.benefitsTitle}>What do I get?</div>
              {BENEFITS.map((txt) => (
                <div key={txt} className={styles.benefitRow}>
                  <svg className={styles.benefitCheck} viewBox="0 0 14 14" aria-hidden="true">
                    <circle cx="7" cy="7" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M4 7l2.2 2.2L10 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                  <span className={styles.benefitText}>{txt}</span>
                </div>
              ))}
            </section>

            <section className={styles.actionArea}>
              <button
                type="button"
                className={styles.primaryCta}
                onClick={() => {
                  trackClientEvent(PPP_EVENTS.LEAD_CTA_CLICK, { plan: selectedPlan });
                  setCurrentView('reserve');
                }}
              >
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
