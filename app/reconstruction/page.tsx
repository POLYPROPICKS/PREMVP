'use client';

import { useState, useEffect, useCallback } from 'react';
import styles from './Reconstruction.module.css';
import { premiumSignals } from '@/content/signals';
import { marketSources } from '@/content/marketSources';

export default function ReconstructionPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [apiError, setApiError] = useState('');

  const activeSignal = premiumSignals[0];

  const openModal = useCallback(() => {
    setIsModalOpen(true);
    setIsSuccess(false);
    setEmail('');
    setEmailError('');
    setApiError('');
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    setIsSuccess(false);
    setEmail('');
    setEmailError('');
    setApiError('');
  }, []);

  const validateEmail = (email: string): boolean => {
    return email.includes('@') && email.includes('.');
  };

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateEmail(email)) {
      setEmailError('Please enter a valid email');
      return;
    }

    const captureData = {
      email,
      signalId: activeSignal.id,
      eventTitle: activeSignal.eventTitle,
      position: activeSignal.position,
      winProbability: activeSignal.winProbability,
      price: activeSignal.price,
      source: 'cta_modal',
      createdAt: new Date().toISOString(),
    };

    // Always save to localStorage as fallback/debug
    localStorage.setItem('polypropicks_lead_capture', JSON.stringify(captureData));

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(captureData),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        setIsSuccess(true);
        setEmailError('');
        setApiError('');
      } else {
        setApiError('Saved locally. We could not sync yet.');
        setEmailError('');
      }
    } catch {
      setApiError('Saved locally. We could not sync yet.');
      setEmailError('');
    }
  }, [email, activeSignal]);

  // Escape key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isModalOpen) {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isModalOpen, closeModal]);

  return (
    <main className={styles.page}>
      <div className={styles.proofMarker}>
        RECONSTRUCTION_RESET_ACTIVE
      </div>
      
      <section className={styles.viewport}>
        <div className={styles.screen}>
          <StatusBar />
          <Header />
          <MarketSourceCard />
          <PillsRow />
          <PremiumSignalCard onCtaClick={openModal} />
        </div>
      </section>

      {isModalOpen && (
        <UnlockModal
          isOpen={isModalOpen}
          onClose={closeModal}
          email={email}
          setEmail={setEmail}
          emailError={emailError}
          apiError={apiError}
          isSuccess={isSuccess}
          onSubmit={handleSubmit}
          activeSignal={activeSignal}
        />
      )}
    </main>
  );
}

function StatusBar() {
  return (
    <div className={styles.statusBar}>
      <div className={styles.statusTime}>9:41</div>
      <div className={styles.statusIcons}>
        <div className={styles.cellular}>
          <span />
          <span />
          <span />
          <span />
        </div>
        <svg viewBox="0 0 20 14" className={styles.wifi} aria-hidden="true">
          <path
            d="M2 5.5C6.8 1.5 13.2 1.5 18 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M5 8.5C8.3 5.8 11.7 5.8 15 8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M8.2 11.2c1.2-1 2.4-1 3.6 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
        <div className={styles.battery}>
          <div className={styles.batteryFill} />
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.brandWrap}>
        <img className={styles.brandLogo} src="/brand/polypropicks-mark.png" alt="PolyProPicks" draggable="false" />
        <div className={styles.brandText}>PolyProPicks</div>
      </div>
      <div className={styles.livePill}>
        <span className={styles.liveDot} />
        <span className={styles.liveText}>Live shark flow</span>
      </div>
    </header>
  );
}

function MarketSourceCard() {
  const activeMarketSource = marketSources[0];
  
  return (
    <section className={styles.marketSourceCard}>
      <div className={styles.marketTop}>
        <div className={styles.marketSourceLabel}>
          <svg viewBox="0 0 24 24" className={styles.eq} aria-hidden="true">
            <path
              d="M3 12h2m3-4v8m4-12v16m4-10v4m4-7v10"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          <span>{activeMarketSource.sourceLabel}</span>
        </div>
        <div className={styles.marketPill}>
          <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
            <path
              d="M4 7.5 13.5 3v8.5L4 21v-8.5L13.5 8M13.5 3 20 7v8.5l-6.5-4"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>{activeMarketSource.platform}</span>
        </div>
        <div className={styles.marketPill}>
          <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
            <path
              d="M8.2 9.2c0-1.8 1.4-3.2 3.2-3.2 1.2 0 2.1.5 2.7 1.4l3.1 3.8a3.2 3.2 0 1 1-5.1 3.9l-1.1-1.4"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>{activeMarketSource.network}</span>
        </div>
        <div className={`${styles.marketPill} ${styles.marketPillTime}`}>
          <span>{activeMarketSource.timeAgo}</span>
        </div>
      </div>
      <div className={styles.marketBody}>
        <div className={styles.marketChartWrap}>
          <svg viewBox="0 0 180 72" className={styles.marketChart} aria-hidden="true">
            <path
              d="M4 60 L14 57 L24 59 L34 52 L44 55 L54 49 L64 52 L74 44 L84 37 L94 43 L104 34 L114 39 L124 30 L134 17 L145 6"
              className={styles.chartLine}
            />
            <path
              d="M4 60 L14 57 L24 59 L34 52 L44 55 L54 49 L64 52 L74 44 L84 37 L94 43 L104 34 L114 39 L124 30 L134 17 L145 6 L145 72 L4 72 Z"
              className={styles.chartFill}
            />
            <circle cx="145" cy="6" r="3.7" className={styles.chartDot} />
          </svg>
          <div className={styles.marketDelta}>{activeMarketSource.delta} ↗</div>
        </div>

        <div className={styles.marketCopy}>
          <div className={styles.marketHeadline}>{activeMarketSource.headline}</div>
          <div className={styles.marketSubline}>{activeMarketSource.subline}</div>
        </div>
      </div>
    </section>
  );
}

function PillsRow() {
  return (
    <div className={styles.pillsRow}>
      <button className={styles.pill}>Live</button>
      <button className={styles.pill}>WC2026</button>
      <button className={`${styles.pill} ${styles.pillActive}`}>Sports</button>
      <button className={styles.pill}>Econ</button>
    </div>
  );
}

function PremiumSignalCard({ onCtaClick }: { onCtaClick: () => void }) {
  const activeSignal = premiumSignals[0];
  
  return (
    <article className={styles.premiumSignalCard}>
      <div className={styles.premiumTop}>
        <div className={styles.leagueMeta}>
          <svg viewBox="0 0 24 24" className={styles.ball} aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="#F4F6FA" />
            <path d="M12 7.1 8.8 9.4 10 13.1h4L15.2 9.4 12 7.1Z" fill="#11161E" />
            <path d="M8.2 10.1 6.1 9.3 4.7 12l1.8 2.5 2.4-.6.9-3.8Z" fill="#11161E" />
            <path d="M15.8 10.1 17.9 9.3 19.3 12l-1.8 2.5-2.4-.6-.9-3.8Z" fill="#11161E" />
            <path d="M8 15.1 6.8 17.7 10 19.2l2-1.5V15H8Z" fill="#11161E" />
            <path d="M16 15.1 17.2 17.7 14 19.2l-2-1.5V15h4Z" fill="#11161E" />
          </svg>
          <span>{activeSignal.league} • {activeSignal.time}</span>
        </div>
        <div className={styles.confidencePill}>
          <svg viewBox="0 0 24 24" className={styles.shield} aria-hidden="true">
            <path
              d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z"
              fill="currentColor"
            />
            <path
              d="m8.7 12.2 2.1 2.1 4.5-4.7"
              stroke="#06220B"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>{activeSignal.confidenceLabel}</span>
        </div>
      </div>
      <h1 className={styles.eventTitle}>{activeSignal.eventTitle}</h1>
      <div className={styles.positionProfit}>
        <div className={styles.positionCol}>
          <div className={styles.label}>Position</div>
          <div className={styles.positionValue}>{activeSignal.position}</div>
          <div className={styles.target} aria-hidden="true">
            <img className={styles.decorIconImg} src="/icons/position-target.png" alt="" />
          </div>
        </div>
        <div className={styles.positionProfitDivider} />
        <div className={styles.profitCol}>
          <div className={styles.label}>Profit</div>
          <div className={styles.profitValue}>{activeSignal.profit}</div>
          <div className={styles.trend} aria-hidden="true">
            <img className={styles.decorIconImg} src="/icons/profit-trend.png" alt="" />
          </div>
        </div>
      </div>
      <div className={styles.analyticsRow}>
        <div className={styles.winCard}>
          <div className={styles.winTitle}>WIN PROBABILITY</div>
          <div className={styles.ring}>
            <div className={styles.ringInner}>
              <span className={styles.ringNumber}>{activeSignal.winProbability}</span>
            </div>
          </div>
        </div>
        <div className={styles.trustCard}>
          <div className={styles.trustHeader}>
            <div className={styles.trustTitle}>TRUST METRICS</div>
            <svg viewBox="0 0 24 24" className={styles.info} aria-hidden="true">
              <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 10.2v5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="12" cy="7.2" r="1.1" fill="currentColor" />
            </svg>
          </div>
          {activeSignal.metrics.map((metric) => (
            <MetricRow
              key={metric.id}
              icon={
                <img
                  className={styles.metricIconImg}
                  src={metric.icon}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
              }
              label={metric.label}
              value={`${metric.value}%`}
              width={`${metric.bar}%`}
            />
          ))}
        </div>
      </div>
      <button className={styles.cta} onClick={onCtaClick}>{activeSignal.ctaLabel} — {activeSignal.price}</button>
    </article>
  );
}

function MetricRow({ icon, label, value, width }: { icon: React.ReactNode; label: string; value: string; width: string }) {
  return (
    <div className={styles.metricRow}>
      <div className={styles.metricIconWrap}>{icon}</div>
      <div className={styles.metricMain}>
        <div className={styles.metricLabel}>{label}</div>
        <div className={styles.metricBar}>
          <div className={styles.metricFill} style={{ width }} />
        </div>
      </div>
      <div className={styles.metricValue}>{value}</div>
    </div>
  );
}

function WhaleIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <path
        d="M5 14c1.5-3.5 5.5-5.5 10-5 2 .2 3.4-.6 4-2 1.4 2.6 1.3 5.8-.2 8.3-1.9 3.1-5.4 5-9 4.7-2.5-.1-4.3.7-5.3 2.3-.8-2.2-.6-4.8.5-7.3Z"
        fill="currentColor"
      />
      <circle cx="16.8" cy="8.5" r="1.1" fill="rgba(2,7,13,.85)" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <path
        d="M12 3c-1.8 0-3.5.7-4.8 1.9A6.7 6.7 0 0 0 5 9.7c0 .7.1 1.4.3 2A4.7 4.7 0 0 0 3 16c0 2.8 2.2 5 5 5 1.3 0 2.6-.5 3.5-1.4.3-.3.8-.3 1.1 0A4.9 4.9 0 0 0 16 21a5 5 0 0 0 4.7-6.8c.2-.5.3-1.1.3-1.7 0-2-1-3.8-2.7-4.9A6.8 6.8 0 0 0 12 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AiChipIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <text x="12" y="15" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="currentColor">
        AI
      </text>
    </svg>
  );
}

interface UnlockModalProps {
  isOpen: boolean;
  onClose: () => void;
  email: string;
  setEmail: (email: string) => void;
  emailError: string;
  apiError: string;
  isSuccess: boolean;
  onSubmit: (e: React.FormEvent) => void;
  activeSignal: {
    eventTitle: string;
    position: string;
    winProbability: number;
    price: string;
  };
}

function UnlockModal({
  isOpen,
  onClose,
  email,
  setEmail,
  emailError,
  apiError,
  isSuccess,
  onSubmit,
  activeSignal,
}: UnlockModalProps) {
  if (!isOpen) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
        <button className={styles.modalClose} onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6L18 18M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {!isSuccess ? (
          <>
            <h2 className={styles.modalTitle}>Unlock full signal</h2>
            <p className={styles.modalSubtitle}>
              Get the full pick, entry logic, confidence breakdown, and movement alerts before odds shift.
            </p>

            <div className={styles.modalPreview}>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Event</span>
                <span className={styles.previewValue}>{activeSignal.eventTitle}</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Position</span>
                <span className={styles.previewValue}>{activeSignal.position}</span>
              </div>
              <div className={styles.previewRow}>
                <span className={styles.previewLabel}>Win Probability</span>
                <span className={styles.previewValue}>{activeSignal.winProbability}%</span>
              </div>
            </div>

            <form onSubmit={onSubmit} className={styles.modalForm}>
              <input
                type="email"
                className={styles.modalInput}
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              {emailError && <span className={styles.modalError}>{emailError}</span>}
              {apiError && <span className={styles.modalError}>{apiError}</span>}
              <button type="submit" className={styles.modalPrimary}>
                Reserve signal access — {activeSignal.price}
              </button>
            </form>

            <p className={styles.modalFineprint}>No spam. Early access users get first pricing.</p>
            <p className={styles.modalFooter}>Full checkout opens in the next step.</p>
          </>
        ) : (
          <div className={styles.modalSuccess}>
            <h2 className={styles.modalTitle}>You&apos;re on the early list</h2>
            <p className={styles.modalSubtitle}>
              We saved your signal request. Next step: checkout and live alerts.
            </p>
            <button className={styles.modalPrimary} onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
