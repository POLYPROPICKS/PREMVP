import type { PMScreenshot } from '../types';
import styles from './Screenshots.module.css';

export default function PolymarketScreenshot({ data }: { data: PMScreenshot }) {
  return (
    <div className={styles.zonePm}>
      <div className={styles.pmNav}>
        <div className={styles.pmLogoWrap}>
          <img src="/testimonials/logos/polymarket-logo.png" className={styles.pmLogoImg} alt="Polymarket" />
          <span className={styles.pmWordmark}>Polymarket</span>
          <span className={styles.pmFlag}>{data.flag}</span>
        </div>
        <div className={styles.pmNavRight}>
          <div className={styles.pmPortfolioWrap}>
            <div className={styles.pmStatItem}>
              <span className={styles.pmStatLabel}>Portfolio</span>
              <span className={`${styles.pmStatVal} ${styles.pmStatValGreen}`}>{data.portfolio}</span>
            </div>
            <div className={styles.pmStatItem}>
              <span className={styles.pmStatLabel}>Cash</span>
              <span className={`${styles.pmStatVal} ${styles.pmStatValBlue}`}>{data.cash}</span>
            </div>
          </div>
          <button className={styles.pmDepositBtn}>Deposit</button>
        </div>
      </div>

      <div className={styles.pmTabs}>
        <div className={styles.pmTab}>Positions</div>
        <div className={styles.pmTab}>Open orders</div>
        <div className={`${styles.pmTab} ${styles.pmTabActive}`}>History</div>
      </div>

      <div className={styles.pmColHeaders}>
        <div className={styles.pmColAct}>Activity</div>
        <div className={styles.pmColMkt}>Market</div>
        <div className={styles.pmColVal}>Value ◇</div>
        <div className={styles.pmColTime}>Time ◇</div>
      </div>

      {data.rows.map((row, i) => (
        <div key={i} className={`${styles.pmRow} ${row.highlight ? styles.pmRowWin : ''}`}>
          <div className={styles.pmActWrap}>
            <div className={styles.pmActIcon}>{row.activity === 'Sell' ? '−' : '+'}</div>
            <div className={styles.pmActLabel}>{row.activity}</div>
          </div>
          <div className={styles.pmMktCol}>
            <div className={styles.pmThumb}>{row.emoji}</div>
            <div className={styles.pmMktInner}>
              <div className={styles.pmMktName}>{row.eventName}</div>
              <div className={styles.pmMktMeta}>
                <span className={`${styles.pmPill} ${row.pill === 'yes' ? styles.pmPillYes : styles.pmPillNo}`}>
                  {row.pill === 'yes' ? 'Yes' : 'No'} {row.pillPrice}
                </span>
                <span className={styles.pmShares}>{row.shares}</span>
              </div>
            </div>
          </div>
          <div className={`${styles.pmVal} ${row.valueType === 'pos' ? styles.pmValPos : row.valueType === 'neg' ? styles.pmValNeg : styles.pmValNeu}`}>
            {row.value}
          </div>
          <div className={styles.pmTime}>{row.timeAgo}</div>
        </div>
      ))}
    </div>
  );
}
