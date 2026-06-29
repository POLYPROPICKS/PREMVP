'use client';

import styles from './ReferralNudgeSheet.module.css';
import { trackClientEvent } from '@/lib/analytics/posthogClient';
import { PPP_EVENTS } from '@/lib/analytics/events';

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
        <a
          href="/referral"
          className={styles.cta}
          onClick={() =>
            trackClientEvent(PPP_EVENTS.REFERRAL_CTA_CLICK, {
              source_surface: 'referral_nudge_sheet',
              cta_label: 'Invite a friend',
            })
          }
        >
          Invite a friend
        </a>
      </div>
    </>
  );
}
