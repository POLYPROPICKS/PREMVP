import type { FanDuelScreenshot } from '../types';
import styles from './Screenshots.module.css';

export default function FanDuelSlip({ data }: { data: FanDuelScreenshot }) {
  return (
    <div className={styles.zoneFanduel}>
      <div className={styles.fdChrome}>
        <div className={styles.fdLogoBar}>
          <div className={styles.fdLogoWrap}>
            <img src="/testimonials/logos/fanduel-logo.png" className={styles.brandLogoImg} alt="FanDuel" />
          </div>
          <span className={styles.fdAccount}>My Account</span>
        </div>
        <div className={styles.fdTabs}>
          <div className={styles.fdTab}>All</div>
          <div className={styles.fdTab}>Open</div>
          <div className={`${styles.fdTab} ${styles.fdTabActive}`}>
            Settled <span className={styles.fdTabBadge}>1</span>
          </div>
          <div className={styles.fdTab}>Cash Out</div>
        </div>
      </div>

      <div className={styles.fdBet}>
        <div className={styles.fdStatusRow}>
          <div className={styles.fdWonBadge}>
            <div className={styles.fdWonDot} />
            WON
          </div>
          <div className={styles.fdDate}>{data.date}</div>
        </div>

        <div className={styles.fdEventLeague}>{data.league}</div>
        <div className={styles.fdEventName}>{data.event}</div>
        <div className={styles.fdSelection}>Selection: <span>{data.selection}</span></div>
        <div className={styles.fdResult}>Result: <span>{data.result}</span></div>

        <div className={styles.fdDivider} />

        <div className={styles.fdPayoutGrid}>
          <div className={styles.fdPayoutItem}>
            <div className={styles.fdPayoutLabel}>Wager</div>
            <div className={styles.fdPayoutVal}>{data.wager}</div>
          </div>
          <div className={styles.fdPayoutItem}>
            <div className={styles.fdPayoutLabel}>Payout</div>
            <div className={`${styles.fdPayoutVal} ${styles.fdPayoutValPayout}`}>{data.payout}</div>
          </div>
          <div className={styles.fdPayoutItem}>
            <div className={styles.fdPayoutLabel}>Net Profit</div>
            <div className={`${styles.fdPayoutVal} ${styles.fdPayoutValProfit}`}>{data.netProfit}</div>
          </div>
        </div>
      </div>

      <div className={styles.fdFooter}>
        <span className={styles.fdBetId}>{data.betId}</span>
        <button className={styles.fdShareBtn}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1493ff" strokeWidth="2.5" aria-hidden="true">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
          </svg>
          Share
        </button>
      </div>
    </div>
  );
}
