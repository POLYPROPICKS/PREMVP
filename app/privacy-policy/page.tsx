// app/privacy-policy/page.tsx
import { readFileSync } from 'fs';
import { join } from 'path';
import LegalDocument from '@/components/legal/LegalDocument';

export const metadata = {
  title: 'Privacy Policy | PolyProPicks',
  description: 'Privacy Policy for PolyProPicks by Benefitpoint Alexander Grushin.',
};

export default function PrivacyPolicyPage() {
  const text = readFileSync(join(process.cwd(), 'content/legal/privacy-policy.txt'), 'utf8');
  return <LegalDocument text={text} />;
}
