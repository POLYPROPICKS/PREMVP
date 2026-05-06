'use client';

import { useState, useCallback, useEffect } from 'react';
import { premiumSignals, PremiumSignal } from '@/content/signals';

interface PremiumEventCarouselProps {
  renderCard?: (signal: PremiumSignal, onCtaClick: () => void) => React.ReactNode;
  onActiveSignalChange?: (signal: PremiumSignal) => void;
  onCtaClick?: () => void;
  signals?: PremiumSignal[];
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
}

export default function PremiumEventCarousel({
  renderCard,
  onActiveSignalChange,
  onCtaClick,
  signals,
  activeIndex,
  onActiveIndexChange,
}: PremiumEventCarouselProps) {
  const [internalActiveIndex, setInternalActiveIndex] = useState(0);

  const items = signals && signals.length > 0 ? signals : premiumSignals;
  const isControlled = typeof activeIndex === 'number';
  const currentIndex = isControlled ? activeIndex : internalActiveIndex;

  const goToNext = useCallback(() => {
    const next = (currentIndex + 1) % items.length;
    if (isControlled) {
      onActiveIndexChange?.(next);
    } else {
      setInternalActiveIndex(next);
    }
  }, [currentIndex, items.length, isControlled, onActiveIndexChange]);

  const goToPrev = useCallback(() => {
    const prev = (currentIndex - 1 + items.length) % items.length;
    if (isControlled) {
      onActiveIndexChange?.(prev);
    } else {
      setInternalActiveIndex(prev);
    }
  }, [currentIndex, items.length, isControlled, onActiveIndexChange]);

  // Notify parent of active signal change
  useEffect(() => {
    onActiveSignalChange?.(items[currentIndex]);
  }, [currentIndex, items, onActiveSignalChange, internalActiveIndex]);

  // Auto-advance every 5 seconds (only when not controlled)
  useEffect(() => {
    if (isControlled) return;

    const interval = setInterval(() => {
      const next = (currentIndex + 1) % items.length;
      setInternalActiveIndex(next);
    }, 5000);
    return () => clearInterval(interval);
  }, [currentIndex, items.length, isControlled, onActiveIndexChange, internalActiveIndex]);

  const activeSignal = items[currentIndex];

  return (
    <div style={{ position: 'relative' }}>
      {/* Active card */}
      {renderCard ? renderCard(activeSignal, onCtaClick || (() => {})) : null}

      {/* Navigation controls - subtle/invisible */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          transform: 'translateY(-50%)',
          display: 'flex',
          justifyContent: 'space-between',
          padding: '0 8px',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        <button
          onClick={goToPrev}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.3)',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer',
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            opacity: 0.3,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.6')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.3')}
          aria-label="Previous"
        >
          ‹
        </button>
        <button
          onClick={goToNext}
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.3)',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer',
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            opacity: 0.3,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.6')}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.3')}
          aria-label="Next"
        >
          ›
        </button>
      </div>

      {/* Index indicator - subtle dots */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '6px',
          marginTop: '8px',
          opacity: 0.4,
        }}
      >
        {items.map((_, idx) => (
          <span
            key={idx}
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: idx === currentIndex ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
              transition: 'background 0.2s',
            }}
          />
        ))}
      </div>
    </div>
  );
}
