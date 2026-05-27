import type { DraftKingsScreenshot } from '../types';
import styles from './Screenshots.module.css';

export default function DraftKingsSlip({ data }: { data: DraftKingsScreenshot }) {
  return (
    <div className={styles.zoneDraftkings}>
      <div className={styles.dkChrome}>
        <div className={styles.dkLogoBar}>
          <div className={styles.dkLogoWrap}>
            <img src="/testimonials/logos/draftkings-logo.png" className={styles.brandLogoImg} alt="DraftKings" />
            <span className={styles.dkWordmark}>Draft<span>Kings</span></span>
          </div>
          <span className={styles.dkAccount}>My Bets</span>
        </div>
        <div className={styles.dkSearch}>
          <span className={styles.dkSearchIcon}>🔍</span>
          <span className={styles.dkSearchText}>Search bets...</span>
        </div>
        <div className={styles.dkTabs}>
          <div className={styles.dkTab}>All <span className={styles.dkTabCount}>(4)</span></div>
          <div className={styles.dkTab}>Open <span className={styles.dkTabCount}>(1)</span></div>
          <div className={`${styles.dkTab} ${styles.dkTabActive}`}>Won <span className={styles.dkTabCount}>(2)</span></div>
        </div>
      </div>

      <div className={styles.dkBet}>
        <div className={styles.dkBetHeader}>
          <div>
            <div className={styles.dkWonBadge}>
              <span className={styles.dkWonIcon}>🟢</span>WON
            </div>
            <div className={styles.dkBetType}>Single Bet</div>
          </div>
          <div className={styles.dkPayoutHeader}>
            <span className={styles.dkPayoutLabel}>Total Payout</span>
            <span className={styles.dkPayoutVal}>{data.totalPayout}</span>
          </div>
        </div>

        <div className={styles.dkBetBody}>
          <div className={styles.dkLeague}>{data.league}</div>
          <div className={styles.dkEventName}>{data.event}</div>
          <div className={styles.dkSelectionRow}>
            <div className={styles.dkSelectionLeft}>
              <div className={styles.dkSelectionName}>{data.selection}</div>
              <div className={styles.dkSelectionResult}>{data.result}</div>
            </div>
            <div className={styles.dkSelectionOdds}>{data.odds}</div>
          </div>
          <div className={styles.dkBetRow}>
            <div className={styles.dkBetItem}>
              <div className={styles.dkBetItemLabel}>Wager</div>
              <div className={styles.dkBetItemVal}>{data.wager}</div>
            </div>
            <div className={styles.dkBetItem} style={{ textAlign: 'center' }}>
              <div className={styles.dkBetItemLabel}>Odds</div>
              <div className={styles.dkBetItemVal}>{data.odds}</div>
            </div>
            <div className={styles.dkBetItem} style={{ textAlign: 'right' }}>
              <div className={styles.dkBetItemLabel}>Profit</div>
              <div className={`${styles.dkBetItemVal} ${styles.dkBetItemValProfit}`}>{data.profit}</div>
            </div>
          </div>
        </div>

        <div className={styles.dkFooter}>
          <span className={styles.dkBetId}>{data.betId}</span>
          <button className={styles.dkShareBtn}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" strokeWidth="2.5" aria-hidden="true">
              <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
            </svg>
            Share to Social
          </button>
        </div>
      </div>
    </div>
  );
}
