'use client';

import styles from './TestimonialsSection.module.css';
import TestimonialCard from './TestimonialCard';
import { TESTIMONIAL_CARDS } from './mockData';
import type { TestimonialCard as TCard } from './types';

// ── Header platform SVGs ──────────────────────────────────────

function HeaderTikTok() {
  return (
    <div className={styles.ppill} style={{ background: '#010101' }}>
      <svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M21 2c.3 2.5 1.7 4.2 4 5.3v3.6c-1.4.1-2.7-.3-4-1v9.1c0 4.6-3.5 8-8 8s-8-3.4-8-8 3.5-8 8-8c.4 0 .7 0 1 .1v3.7c-.3-.1-.7-.1-1-.1-2.4 0-4 1.7-4 4.3s1.6 4.3 4 4.3 4-1.8 4-4.3V2h4z" fill="#fff" />
      </svg>
    </div>
  );
}

function HeaderInstagram() {
  return (
    <div className={styles.ppill}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <defs>
          <radialGradient id="ig-header-pills" cx="28%" cy="105%" r="120%">
            <stop offset="0%"   stopColor="#fdf497" />
            <stop offset="35%"  stopColor="#fd5949" />
            <stop offset="65%"  stopColor="#d6249f" />
            <stop offset="100%" stopColor="#285AEB" />
          </radialGradient>
        </defs>
        <rect width="26" height="26" rx="7" fill="url(#ig-header-pills)" />
        <rect x="7" y="7" width="12" height="12" rx="3.5" fill="none" stroke="#fff" strokeWidth="1.5" />
        <circle cx="13" cy="13" r="3.2" fill="none" stroke="#fff" strokeWidth="1.5" />
        <circle cx="19.2" cy="6.8" r="1" fill="#fff" />
      </svg>
    </div>
  );
}

function HeaderX() {
  return (
    <div className={styles.ppill} style={{ background: '#000' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.713 5.923zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </div>
  );
}

function HeaderTelegram() {
  return (
    <div className={styles.ppill} style={{ background: '#229ed9' }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ── Section component ─────────────────────────────────────────

interface TestimonialsSectionProps {
  cards?: TCard[];
}

export default function TestimonialsSection({ cards = TESTIMONIAL_CARDS }: TestimonialsSectionProps) {
  return (
    <section className={styles.section} aria-label="Verified trader testimonials">
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.title}>The community<br />has spoken</div>
        <div className={styles.ratingRow}>
          <div className={styles.stars}>★★★★★</div>
          <div className={styles.avgNum}>4.9</div>
          <div className={styles.reviewCount}>2.4k traders</div>
          <div className={styles.platformPills}>
            <HeaderTikTok />
            <HeaderInstagram />
            <HeaderX />
            <HeaderTelegram />
          </div>
        </div>
      </div>

      {/* Carousel */}
      <div className={styles.carousel} aria-label="Testimonials carousel">
        {cards.map((card) => (
          <TestimonialCard key={card.id} card={card} />
        ))}
      </div>

    </section>
  );
}
