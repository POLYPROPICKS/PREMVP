import { heroContent } from '@/content/hero-content';
import styles from './HeaderBar.module.css';

export default function HeaderBar() {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <div className={styles.gemIcon} aria-hidden="true"></div>
        <h1 className={styles.brandName}>{heroContent.brandName}</h1>
      </div>
      
      <div className={styles.liveStatus}>
        <div className={styles.liveDot} aria-hidden="true"></div>
        <span className={styles.liveText}>{heroContent.liveStatusText}</span>
      </div>
    </header>
  );
}
