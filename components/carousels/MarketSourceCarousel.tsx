'use client';

import { useState, useCallback, useEffect } from 'react';
import { marketSources, MarketSource } from '@/content/marketSources';

interface MarketSourceCarouselProps {
  renderCard?: (source: MarketSource) => React.ReactNode;
  sources?: MarketSource[];
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
}

export default function MarketSourceCarousel({ renderCard, sources, activeIndex, onActiveIndexChange }: MarketSourceCarouselProps) {
  const [internalActiveIndex, setInternalActiveIndex] = useState(0);

  const items = sources && sources.length > 0 ? sources : marketSources;
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

  // Optional auto-advance every 5 seconds (only when not controlled)
  useEffect(() => {
    if (isControlled) return;
    
    const interval = setInterval(() => {
      goToNext();
    }, 5000);
    return () => clearInterval(interval);
  }, [goToNext, isControlled]);

  const activeSource = items[currentIndex];

  return (
    <div style={{ position: 'relative' }}>
      {/* Active card */}
      {renderCard ? renderCard(activeSource) : null}

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

          </div>
  );
}
