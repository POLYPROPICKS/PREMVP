import { heroContent } from '@/content/hero-content';
import styles from './HeaderBar.module.css';

function GemIcon() {
  return (
    <svg viewBox="0 0 64 64" className={styles.gemIcon} aria-hidden="true">
      <path
        d="M16 18h32l10 14-26 18L6 32l10-14Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinejoin="round"
      />
      <path
        d="M16 18 24 8h16l8 10M6 32h52M24 8l8 24 8-24M16 18l16 14 16-14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function HeaderBar() {
  return (
    <header className={styles.header} aria-label="App header">
      <div className={styles.inner}>
        <div className={styles.brandBlock}>
          <GemIcon />
          <h1 className={styles.brandName}>{heroContent.brandName}</h1>
        </div>

        <div className={styles.livePill} aria-label={heroContent.liveStatusText}>
          <span className={styles.liveDot} />
          <span className={styles.liveText}>{heroContent.liveStatusText}</span>
        </div>
      </div>
    </header>
  );
}