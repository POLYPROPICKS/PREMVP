import PremiumEventCarousel from '@/components/carousels/PremiumEventCarousel';
import CategoryTabs from '@/components/ui/CategoryTabs';

export default function PremiumEventsSection() {
  return (
    <section className="bg-black text-white py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <CategoryTabs />
        <div className="mt-6">
          <PremiumEventCarousel />
        </div>
      </div>
    </section>
  );
}
