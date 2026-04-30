import { premiumEventCards } from '@/content/premium-event-cards';
import { sectionHeadings } from '@/content/section-headings';
import PremiumEventCard from '@/components/cards/PremiumEventCard';
import PaginationDots from '@/components/ui/PaginationDots';

export default function PremiumEventCarousel() {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-black text-white">{sectionHeadings.premiumSignals}</h2>
        <span className="text-xs text-gray-400">{sectionHeadings.swipeHint}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-4 scroll-smooth">
        {premiumEventCards.map((card) => (
          <PremiumEventCard key={card.id} data={card} />
        ))}
      </div>
      <PaginationDots currentIndex={0} total={premiumEventCards.length} />
    </div>
  );
}
