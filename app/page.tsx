import StatusBar from '@/components/layout/StatusBar';
import HeaderBar from '@/components/layout/HeaderBar';
import MarketSourcesSection from '@/components/sections/MarketSourcesSection';
import PremiumEventsSection from '@/components/sections/PremiumEventsSection';
import CTASection from '@/components/sections/CTASection';

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white">
      <StatusBar />
      <HeaderBar />
      <MarketSourcesSection />
      <PremiumEventsSection />
      <CTASection />
    </div>
  );
}
