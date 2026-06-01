// app/terms-of-use/page.tsx
import { readFileSync } from 'fs';
import { join } from 'path';
import LegalDocument from '@/components/legal/LegalDocument';

export const metadata = {
  title: 'Terms of Use | PolyProPicks',
  description: 'Terms of Use for PolyProPicks by Benefitpoint Alexander Grushin.',
};

export default function TermsOfUsePage() {
  const text = readFileSync(join(process.cwd(), 'content/legal/terms-of-use.txt'), 'utf8');
  return <LegalDocument text={text} />;
}
