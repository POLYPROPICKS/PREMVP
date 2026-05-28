// app/legal/page.tsx
import { readFileSync } from 'fs';
import { join } from 'path';
import LegalDocument from '@/components/legal/LegalDocument';

export const metadata = {
  title: 'Legal | PolyProPicks',
  description: 'Legal center for PolyProPicks by Benefitpoint, Inc.',
};

const legalJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'PolyProPicks Legal Center',
  url: 'https://polypropicks.com/legal',
  description:
    'Central index for PolyProPicks terms, privacy policy, risk notices, paid access disclosures, cookie and tracking notices, and user legal information.',
  publisher: {
    '@type': 'Organization',
    name: 'Benefitpoint Inc.',
    url: 'https://polypropicks.com',
    email: 'Alex_ceo@polypropicks.com',
    brand: { '@type': 'Brand', name: 'PolyProPicks' },
  },
  about: [
    { '@type': 'Thing', name: 'Sports market intelligence' },
    { '@type': 'Thing', name: 'Prediction-market signals' },
    { '@type': 'Thing', name: 'Signal Confidence' },
    { '@type': 'Thing', name: 'Risk disclosures' },
  ],
  hasPart: [
    { '@type': 'WebPage', name: 'Terms of Use', url: 'https://polypropicks.com/terms-of-use' },
    { '@type': 'WebPage', name: 'Privacy Policy', url: 'https://polypropicks.com/privacy-policy' },
  ],
};

export default function LegalPage() {
  const text = readFileSync(join(process.cwd(), 'content/legal/legal.md'), 'utf8');
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(legalJsonLd) }}
      />
      <LegalDocument text={text} />
    </>
  );
}
