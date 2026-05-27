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


function HeaderX() {
  return (
    <div className={styles.ppill} style={{ background: '#000' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.713 5.923zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
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
            <a href="https://www.tiktok.com/@polypropicks2026pulse" target="_blank" rel="noopener noreferrer" style={{ display: 'contents' }}><HeaderTikTok /></a>
            <a href="https://x.com/PolyProPicks" target="_blank" rel="noopener noreferrer" style={{ display: 'contents' }}><HeaderX /></a>
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
