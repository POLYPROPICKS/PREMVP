import { ctaContent } from '@/content/cta-content';

export default function CTASection() {
  return (
    <section className="bg-gray-900 text-white py-12 px-4">
      <div className="max-w-4xl mx-auto text-center">
        <h2 className="text-2xl font-bold mb-4">{ctaContent.title}</h2>
        <p className="text-gray-300 mb-8">{ctaContent.subtitle}</p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-3 rounded-lg">
            {ctaContent.primaryButton.text}
          </button>
          <button className="bg-gray-800 hover:bg-gray-700 text-white font-medium px-6 py-3 rounded-lg">
            {ctaContent.secondaryButton.text}
          </button>
        </div>
      </div>
    </section>
  );
}
