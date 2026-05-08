'use client';

import { useState, useEffect, useCallback } from 'react';
import styles from './PassOfferModal.module.css';

type PlanId = '7day' | '3day' | 'monthly';

interface PassOfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReserve: (planId: PlanId) => void;
}

export default function PassOfferModal({ isOpen, onClose, onReserve }: PassOfferModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>('7day');
  const [currentView, setCurrentView] = useState<'offer' | 'reserve'>('offer');
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Close modal on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (!isOpen) return;

    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handlePlanSelect = (planId: PlanId) => {
    setSelectedPlan(planId);
  };

  const handleReserve = () => {
    setCurrentView('reserve');
  };

  const handleBackToOffer = () => {
    setCurrentView('offer');
  };

  const handleReserveSubmit = async () => {
    if (isSubmitting) return;
    
    setIsSubmitting(true);
    
    // Save to localStorage as fallback
    const reserveData = {
      email,
      planId: selectedPlan,
      planName: getPlanDetails(selectedPlan).name,
      price: getPlanDetails(selectedPlan).price,
      timestamp: new Date().toISOString(),
    };
    
    localStorage.setItem('polypropicks_pass_reserve', JSON.stringify(reserveData));
    
    // Simulate submission delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    setIsSubmitting(false);
    onClose();
  };

  const getPlanDetails = (planId: PlanId) => {
    switch (planId) {
      case '7day':
        return {
          name: '7-Day Premium',
          badge: 'MOST POPULAR',
          subtitle: 'Best for this week\'s live markets',
          helper: '$2.71/day',
          price: '$19',
        };
      case '3day':
        return {
          name: '3-Day Pass',
          subtitle: 'Fast access for the next match cycle',
          price: '$9',
        };
      case 'monthly':
        return {
          name: 'Monthly Pro',
          subtitle: 'Best for daily market users',
          helper: '$1.63/day',
          price: '$49',
        };
    }
  };

  const currentPlan = getPlanDetails(selectedPlan);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.container}>
        {/* Top bar */}
        <div className={styles.topBar}>
          <button className={styles.backButton} onClick={onClose}>
            Back to free signal
          </button>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Main content */}
        <div className={styles.content}>
          {currentView === 'offer' ? (
            <>
              {/* Compact hero section */}
              <div className={styles.heroSection}>
                <div className={styles.heroContent}>
                  <div className={styles.lockIcon}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      <circle cx="12" cy="16" r="1" fill="currentColor" />
                    </svg>
                  </div>
                  <div className={styles.lockedLabel}>LIVE SIGNALS LOCKED</div>
                </div>
                <h1 className={styles.headline}>Unlock the next signals before the line moves</h1>
                <p className={styles.subheadline}>
                  Live picks, entry timing, and smart-money context.
                </p>
              </div>

              {/* Compact value block */}
              <div className={styles.valueBlockCompact}>
                <div className={styles.valueItemCompact}>
                  <div className={styles.valueIcon}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27z" fill="currentColor" />
                    </svg>
                  </div>
                  <div className={styles.valueText}>
                    <div className={styles.valueChip}>Signal Confidence + position</div>
                  </div>
                </div>
                <div className={styles.valueItemCompact}>
                  <div className={styles.valueIcon}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 12h2m3-4v8m4-12v16m4-10v4m4-7v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                  </div>
                  <div className={styles.valueText}>
                    <div className={styles.valueChip}>Smart-money evidence</div>
                  </div>
                </div>
              </div>

              {/* Pricing cards */}
              <div className={styles.pricingGridCompact}>
                {(['7day', '3day', 'monthly'] as PlanId[]).map((planId) => {
                  const plan = getPlanDetails(planId);
                  const isSelected = selectedPlan === planId;
                  
                  return (
                    <button
                      key={planId}
                      className={`${styles.pricingCardCompact} ${isSelected ? styles.selected : ''}`}
                      onClick={() => handlePlanSelect(planId)}
                    >
                      {plan.badge && <div className={styles.badge}>{plan.badge}</div>}
                      <div className={styles.planName}>{plan.name}</div>
                      <div className={styles.planHelper}>{plan.subtitle}</div>
                      <div className={styles.planPrice}>{plan.price}</div>
                    </button>
                  );
                })}
              </div>

              {/* Primary CTA */}
              <div className={styles.ctaSection}>
                <button className={styles.primaryCta} onClick={handleReserve}>
                  Reserve {currentPlan.name} — {currentPlan.price}
                </button>
              </div>

              {/* Secondary link */}
              <div className={styles.secondarySection}>
                <button className={styles.secondaryLink} onClick={onClose}>
                  Keep 1 free signal
                </button>
              </div>

              {/* Footer */}
              <div className={styles.footerCompact}>
                Payment is not live yet. We'll notify you when pass opens.
              </div>
            </>
          ) : (
            <>
              {/* Reserve/Waitlist screen */}
              <div className={styles.header}>
                <h2 className={styles.headline}>Reserve your premium access</h2>
              </div>

              <p className={styles.subheadline}>
                Payment is not live yet. Leave your email and we'll notify you when this pass opens.
              </p>

              {/* Email input */}
              <div className={styles.emailSection}>
                <input
                  type="email"
                  className={styles.emailInput}
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              {/* Primary submit CTA */}
              <button className={styles.primaryCta} onClick={handleReserveSubmit} disabled={isSubmitting}>
                {isSubmitting ? 'Reserving...' : 'Reserve My Spot'}
              </button>

              {/* Secondary back action */}
              <button className={styles.secondaryLink} onClick={handleBackToOffer}>
                Back to pricing
              </button>

              {/* Footer */}
              <div className={styles.footer}>
                We'll notify you as soon as {currentPlan.name} becomes available.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
