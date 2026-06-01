// app/faq/page.tsx
import { readFileSync } from 'fs';
import { join } from 'path';
import LegalDocument from '@/components/legal/LegalDocument';

export const metadata = {
  title: 'FAQ | PolyProPicks',
  description: 'Frequently asked questions about PolyProPicks signals, market data, Signal Confidence, and premium access.',
};

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is PolyProPicks?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'PolyProPicks is a sports and prediction-market intelligence platform. It turns noisy market data into simple signal cards with a position, Signal Confidence score, market evidence, and supporting trust metrics. PolyProPicks is not a sportsbook, betting operator, broker, exchange, or financial adviser.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is Signal Confidence?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Signal Confidence is a simplified score that summarizes multiple market-intelligence factors into one number. It may reflect factors such as market movement, odds quality, liquidity, smart-money proxies, whale/public imbalance, and data coverage. Signal Confidence is not a guaranteed win probability.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does PolyProPicks give betting advice?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. PolyProPicks provides informational market intelligence only. We do not tell users to place bets or trades. We do not provide financial, legal, tax, gambling, or investment advice. You are responsible for your own decisions.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does a high Signal Confidence score guarantee a win?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. A high Signal Confidence score does not guarantee a win, profit, payout, or market movement. Sports and prediction markets are uncertain. Historical performance does not guarantee future results.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where does PolyProPicks get market data?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'PolyProPicks may use public market data, prediction-market data, sports-event data, pricing movement, liquidity signals, and third-party sources. Third-party data can be delayed, incomplete, inaccurate, or unavailable, so users should always verify information independently.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does PolyProPicks place trades or bets for users?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. PolyProPicks does not place trades or bets for users. We do not manage user funds, hold balances, process wagers, or execute orders. If you choose to use a third-party platform, sportsbook, exchange, or prediction market, you do so directly with that third party.',
      },
    },
    {
      '@type': 'Question',
      name: 'What does "whale flow" or "smart money" mean on PolyProPicks?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Whale-flow or smart-money language on PolyProPicks refers to market-data interpretation and proxy signals, such as unusually large trades, concentrated activity, or market movement. It does not mean we have verified institutional or insider information. These are market-intelligence signals, not guaranteed outcomes.',
      },
    },
    {
      '@type': 'Question',
      name: 'What are Trust Metrics?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Trust Metrics are supporting indicators that help explain why a signal appeared. Examples may include Smart Money, Whale vs Public Money, Injury data & PreMatchPower, market movement, odds quality, liquidity, and data coverage. They should not be treated as guarantees.',
      },
    },
    {
      '@type': 'Question',
      name: 'Can market information change after a signal appears?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. Market information can change quickly. A signal may become weaker, stronger, stale, or irrelevant after publication because of odds movement, liquidity changes, injury news, lineup updates, market suspension, event cancellation, or new public information.',
      },
    },
    {
      '@type': 'Question',
      name: 'Who is PolyProPicks built for?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'PolyProPicks is built for people who follow sports markets, prediction markets, odds movement, and market-based signals but want a faster way to understand what matters — without reading raw market pages, order books, or fragmented signal channels.',
      },
    },
  ],
};

export default function FaqPage() {
  const text = readFileSync(join(process.cwd(), 'content/legal/faq.md'), 'utf8');
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <LegalDocument text={text} />
    </>
  );
}
