'use client';

import { useState, useCallback, useEffect } from 'react';
import { marketSources, MarketSource } from '@/content/marketSources';

interface MarketSourceCarouselProps {
  renderCard?: (source: MarketSource) => React.ReactNode;
}

export default function MarketSourceCarousel({ renderCard }: MarketSourceCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  const goToNext = useCallback(() => {
    setActiveIndex((prev) => (prev + 1) % marketSources.length);
  }, []);

  const goToPrev = useCallback(() => {
    setActiveIndex((prev) => (prev - 1 + marketSources.length) % marketSources.length);
  }, []);

  // Optional auto-advance every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      goToNext();
    }, 5000);
    return () => clearInterval(interval);
  }, [goToNext]);

  const activeSource = marketSources[activeIndex];

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
        {marketSources.map((_, idx) => (
          <span
            key={idx}
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: idx === activeIndex ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.3)',
              transition: 'background 0.2s',
            }}
          />
        ))}
      </div>
    </div>
  );
}
