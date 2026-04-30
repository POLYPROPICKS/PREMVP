import { heroContent } from '@/content/hero-content';

export default function HeroSection() {
  return (
    <header className="bg-black text-white px-4 py-2">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center">
              <span className="text-white font-bold text-xs">P</span>
            </div>
            <h1 className="text-sm font-bold">{heroContent.brandName}</h1>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
            <span className="text-xs font-medium text-green-400">{heroContent.liveStatusText}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
