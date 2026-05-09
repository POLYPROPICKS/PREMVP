'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import styles from './PassOfferModal.module.css';

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
    id: '3day',
    name: '24-Hour Pass',
    subtitle: 'Unlock today\'s premium feed',
    helper: '24-hour access',
    price: '$4.99',
    perDay: '$4.99',
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

  const currentPlan = useMemo(() => getPlan(selectedPlan), [selectedPlan]);

  const resetAndClose = useCallback(() => {
    setCurrentView('offer');
    setEmail('');
    setEmailError('');
    setIsSubmitting(false);
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
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const primaryCta = `Unlock ${currentPlan.name} — ${currentPlan.price}`;

  const handleSubmitReserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedEmail = email.trim();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setEmailError('Enter a valid email to reserve access.');
      return;
    }

    if (isSubmitting) return;

    setIsSubmitting(true);
    setEmailError('');

    const reserveData = {
      email: normalizedEmail,
      planId: selectedPlan,
      planName: currentPlan.name,
      price: currentPlan.price,
      timestamp: new Date().toISOString(),
      source: 'pass_offer_modal',
    };

    try {
      localStorage.setItem('polypropicks_pass_reserve', JSON.stringify(reserveData));
      onPremiumReserve({
        email: normalizedEmail,
        planId: selectedPlan,
        planName: currentPlan.name,
        planPrice: currentPlan.price,
      });
      setCurrentView('reserved');
    } catch {
      setEmailError('Could not save locally. Try again.');
    } finally {
      setIsSubmitting(false);
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
              <div className={styles.chartLabel}>Past 7 days</div>
              <div className={styles.chartBody}>
                <svg className={styles.chartSvg} viewBox="0 0 220 84" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="paywallGreenLine" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#72ff48" stopOpacity="0.72" />
                      <stop offset="1" stopColor="#a8ff32" stopOpacity="1" />
                    </linearGradient>
                    <linearGradient id="paywallCyanLine" x1="0" x2="1" y1="0" y2="0">
                      <stop offset="0" stopColor="#28d4ff" stopOpacity="0.72" />
                      <stop offset="1" stopColor="#54dfff" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  <path className={styles.gridLine} d="M0 18H220M0 38H220M0 58H220M26 0V84M55 0V84M84 0V84M113 0V84M142 0V84M171 0V84M200 0V84" />
                  <path className={styles.axisLine} d="M0 74H220" />
                  <path className={styles.cyanLine} d="M0 68 L12 65 L24 64 L36 60 L48 59 L60 57 L72 54 L84 53 L96 50 L108 49 L120 48 L132 46 L144 44 L156 43 L168 41 L180 39 L192 37 L204 35 L218 30" />
                  <path className={styles.greenLine} d="M0 60 L12 56 L24 54 L36 50 L48 47 L60 44 L72 39 L84 36 L96 34 L108 30 L120 27 L132 24 L144 19 L156 21 L168 18 L180 17 L192 15 L204 12 L218 5" />
                  <circle cx="218" cy="5" r="2.4" className={styles.greenPoint} />
                  <circle cx="218" cy="30" r="2.2" className={styles.cyanPoint} />
                </svg>

                <div className={styles.chartLegend}>
                  <div>
                    <span className={styles.greenBullet} />
                    <span>Middle Confidence</span>
                    <strong>+240%</strong>
                  </div>
                  <div>
                    <span className={styles.cyanBullet} />
                    <span>High Confidence</span>
                    <strong>+170%</strong>
                  </div>
                </div>
              </div>
            </section>

            <section className={styles.benefits} aria-label="Premium benefits">
              <div><span />Enter before odds move</div>
              <div><span />Smart-money reversal alerts</div>
              <div><span />Access to premium WC2026 pool</div>
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
              <button type="button" className={styles.secondaryLink} onClick={resetAndClose}>
                Keep only 1 free signal
              </button>
              <p className={styles.legalText}>
                Signals are probabilistic, not guaranteed outcomes.<br />
                Past signal P&amp;L does not guarantee future results. Not financial advice.<br />
                Cancel anytime. {currentPlan.price} weekly until canceled.
              </p>
            </section>
          </main>
        ) : currentView === 'reserve' ? (
          <main className={styles.reserveView}>
            <section className={styles.reserveCard}>
              <div className={styles.reserveLock} aria-hidden="true">✓</div>
              <h2>Reserve your premium access</h2>
              <p>
                Premium access for this month is currently limited. Leave your email and we'll notify you when new invite spots open.
              </p>
              <form onSubmit={handleSubmitReserve} className={styles.reserveForm}>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  className={styles.emailInput}
                  disabled={isSubmitting}
                  aria-label="Email address"
                />
                {emailError && <div className={styles.emailError}>{emailError}</div>}
                <button type="submit" className={styles.primaryCta} disabled={isSubmitting}>
                  {isSubmitting ? 'Reserving…' : 'Reserve My Spot'}
                </button>
              </form>
              <button type="button" className={styles.secondaryLink} onClick={() => setCurrentView('offer')}>
                Back to pricing
              </button>
              <p className={styles.legalText}>
                No payment is taken now.
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
