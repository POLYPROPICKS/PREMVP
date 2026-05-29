'use client';

import styles from './ReferralNudgeSheet.module.css';

interface ReferralNudgeSheetProps {
  onClose: () => void;
}

export default function ReferralNudgeSheet({ onClose }: ReferralNudgeSheetProps) {
  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.sheet} role="dialog" aria-label="Referral offer">
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Dismiss"
        >
          ×
        </button>
        <p className={styles.headline}>
          No cash? Get $30 Credit for inviting a friend
        </p>
        <a href="/referral" className={styles.cta}>
          Invite a friend
        </a>
      </div>
    </>
  );
}
