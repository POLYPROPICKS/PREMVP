'use client';

import { useState, useCallback, useEffect, type CSSProperties } from 'react';
import { premiumSignals, PremiumSignal } from '@/content/signals';

interface PremiumEventCarouselProps {
  renderCard?: (signal: PremiumSignal, onCtaClick: () => void) => React.ReactNode;
  onActiveSignalChange?: (signal: PremiumSignal) => void;
  onCtaClick?: () => void;
  signals?: PremiumSignal[];
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  onLockedFeedAttempt?: () => void;
}

const feedStyle = {
  position: 'relative',
  width: '100%',
  overflow: 'hidden',
  ['--premium-feed-pad' as string]: 'clamp(12px, 3.7vw, 16px)',
  ['--premium-feed-gap' as string]: 'clamp(10px, 2.8vw, 12px)',
  ['--premium-peek-width' as string]: 'clamp(28px, 7vw, 34px)',
  ['--premium-card-width' as string]:
    'calc(min(100vw, 428px) - var(--premium-feed-pad) - var(--premium-feed-gap) - var(--premium-peek-width))',
} as CSSProperties;

const trackStyle = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 'var(--premium-feed-gap)',
  paddingLeft: 'var(--premium-feed-pad)',
  width: 'max-content',
  transform: 'translateX(0)',
} as CSSProperties;

const slideStyle = {
  flex: '0 0 var(--premium-card-width)',
  width: 'var(--premium-card-width)',
} as CSSProperties;

const peekSlideStyle = {
  ...slideStyle,
  position: 'relative',
} as CSSProperties;

const lockedOverlayStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: 0,
} as CSSProperties;

export default function PremiumEventCarousel({
  renderCard,
  onActiveSignalChange,
  onCtaClick,
  signals,
  activeIndex,
  onActiveIndexChange,
  onLockedFeedAttempt,
}: PremiumEventCarouselProps) {
  const [internalActiveIndex, setInternalActiveIndex] = useState(0);

  const items = signals && signals.length > 0 ? signals : premiumSignals;
  const isControlled = typeof activeIndex === 'number';
  const currentIndex = isControlled ? activeIndex : internalActiveIndex;

  const goToNext = useCallback(() => {
    if (isControlled && onLockedFeedAttempt) {
      onLockedFeedAttempt();
      return;
    }

    const next = (currentIndex + 1) % items.length;
    if (isControlled) {
      onActiveIndexChange?.(next);
    } else {
      setInternalActiveIndex(next);
    }
  }, [currentIndex, items.length, isControlled, onActiveIndexChange, onLockedFeedAttempt]);

  const goToPrev = useCallback(() => {
    if (isControlled && onLockedFeedAttempt) {
      onLockedFeedAttempt();
      return;
    }

    const prev = (currentIndex - 1 + items.length) % items.length;
    if (isControlled) {
      onActiveIndexChange?.(prev);
    } else {
      setInternalActiveIndex(prev);
    }
  }, [currentIndex, items.length, isControlled, onActiveIndexChange, onLockedFeedAttempt]);

  useEffect(() => {
    onActiveSignalChange?.(items[currentIndex]);
  }, [currentIndex, items, onActiveSignalChange]);

  useEffect(() => {
    if (isControlled) return;

    const interval = setInterval(() => {
      const next = (currentIndex + 1) % items.length;
      setInternalActiveIndex(next);
    }, 5000);

    return () => clearInterval(interval);
  }, [currentIndex, items.length, isControlled, onActiveIndexChange]);

  const activeSignal = items[currentIndex];
  const peekSignal = items.length > 1 ? items[(currentIndex + 1) % items.length] : null;

  return (
    <div style={feedStyle}>
      <div style={trackStyle}>
        <div style={slideStyle}>
          {renderCard ? renderCard(activeSignal, onCtaClick || (() => {})) : null}
        </div>

        {peekSignal && (
          <div style={peekSlideStyle} aria-hidden="true">
            {renderCard ? renderCard(peekSignal, onLockedFeedAttempt || (() => {})) : null}

            <button
              type="button"
              aria-label="Unlock more premium signals"
              onClick={onLockedFeedAttempt}
              style={lockedOverlayStyle}
            />
          </div>
        )}
      </div>
    </div>
  );
}
