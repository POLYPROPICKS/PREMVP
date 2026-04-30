import { marketSourceCards } from '@/content/market-source-cards';
import { sectionHeadings } from '@/content/section-headings';
import MarketSourceCard from '@/components/cards/MarketSourceCard';

export default function MarketSourceCarousel() {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-black text-white">{sectionHeadings.marketSignals}</h2>
        <span className="text-xs text-gray-400">{sectionHeadings.swipeHint}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-4 scroll-smooth">
        {marketSourceCards.map((card, index) => (
          <MarketSourceCard key={card.id} data={card} />
        ))}
      </div>
    </div>
  );
}
