import type { TestimonialCard as TCard, Platform } from './types';
import styles from './TestimonialCard.module.css';
import PolymarketScreenshot from './screenshots/PolymarketScreenshot';
import FanDuelSlip from './screenshots/FanDuelSlip';
import DraftKingsSlip from './screenshots/DraftKingsSlip';

// ── Platform SVG icons ────────────────────────────────────────

function TikTokIcon() {
  return (
    <svg className={styles.platSvg} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="16" fill="#010101" />
      <path d="M21 6c.3 2 1.4 3.4 3.2 4.2v2.9c-1.1.1-2.2-.3-3.2-.8v7.2c0 3.7-2.8 6.5-6.4 6.5S8.2 23.2 8.2 19.5s2.8-6.5 6.4-6.5c.3 0 .6 0 .8.1v3c-.2 0-.5-.1-.8-.1-1.9 0-3.2 1.4-3.2 3.5s1.3 3.5 3.2 3.5 3.2-1.5 3.2-3.5V6h3z" fill="#fff" />
    </svg>
  );
}

function InstagramIcon({ uid }: { uid: string }) {
  const gId = `ig-${uid}`;
  return (
    <svg className={styles.platSvg} viewBox="0 0 26 26" aria-hidden="true">
      <defs>
        <radialGradient id={gId} cx="28%" cy="105%" r="120%">
          <stop offset="0%"   stopColor="#fdf497" />
          <stop offset="35%"  stopColor="#fd5949" />
          <stop offset="65%"  stopColor="#d6249f" />
          <stop offset="100%" stopColor="#285AEB" />
        </radialGradient>
      </defs>
      <rect width="26" height="26" rx="13" fill={`url(#${gId})`} />
      <rect x="7" y="7" width="12" height="12" rx="3" fill="none" stroke="#fff" strokeWidth="1.4" />
      <circle cx="13" cy="13" r="3" fill="none" stroke="#fff" strokeWidth="1.4" />
      <circle cx="19" cy="7" r="1" fill="#fff" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className={styles.platSvg} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="12" fill="#000" />
      <path d="M17.05 3.5h2.91l-6.36 7.27 7.48 9.9h-5.86l-4.14-5.48-4.75 5.48H3.42l6.8-7.78L3 3.5h6.01l3.75 4.96zm-1.02 15.43h1.61L8.14 5.15H6.4z" fill="#fff" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg className={styles.platSvg} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="12" fill="#229ed9" />
      <path d="M21 5L13.5 19l-2.5-5.5L5 11z" fill="#fff" />
    </svg>
  );
}

function PlatformIcon({ platform, cardId }: { platform: Platform; cardId: string }) {
  if (platform === 'tiktok')    return <TikTokIcon />;
  if (platform === 'instagram') return <InstagramIcon uid={cardId} />;
  if (platform === 'x')         return <XIcon />;
  return <TelegramIcon />;
}

const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok:    'TikTok',
  instagram: 'Instagram',
  x:         'Twitter / X',
  telegram:  'Telegram',
};

// ── Card component ────────────────────────────────────────────

export default function TestimonialCard({ card }: { card: TCard }) {
  return (
    <article className={styles.card}>
      {/* Zone 1: Quote */}
      <div className={styles.zoneQuote}>
        <div className={styles.quoteText}>"{card.quote}"</div>
        <div className={styles.quoteAuthor}>
          <div className={styles.authorLeft}>
            <img className={styles.avatar} src={card.avatarUrl} alt="" loading="lazy" />
            <div>
              <div className={styles.authorName}>{card.username}</div>
              <div className={styles.authorPlatform}>
                <PlatformIcon platform={card.platform} cardId={card.id} />
                {PLATFORM_LABEL[card.platform]}
              </div>
            </div>
          </div>
          <div className={styles.authorArrow}>›</div>
        </div>
      </div>

      {/* Zone 2: Verified */}
      <div className={styles.zoneVerified}>
        <div className={styles.verifiedLeft}>
          <div className={styles.verifiedBadge}>
            <div className={styles.vDot} />
            Verified result
          </div>
          <div className={styles.verifiedEvent}>{card.verifiedEvent}</div>
        </div>
        <div className={styles.verifiedPnl}>{card.verifiedPnl}</div>
      </div>

      {/* Zone 3: Screenshot skin */}
      {card.screenshot.type === 'polymarket' && (
        <PolymarketScreenshot data={card.screenshot} />
      )}
      {card.screenshot.type === 'fanduel' && (
        <FanDuelSlip data={card.screenshot} />
      )}
      {card.screenshot.type === 'draftkings' && (
        <DraftKingsSlip data={card.screenshot} />
      )}
    </article>
  );
}
