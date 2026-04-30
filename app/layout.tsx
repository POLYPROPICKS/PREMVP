import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://polypropicks.com"),
  title: "PolyProPicks — Premium Sports Signal Intelligence",
  description: "Premium sports signal previews, market-source movement, confidence scoring, and early betting intelligence before odds shift.",
  openGraph: {
    title: "PolyProPicks — Premium Sports Signal Intelligence",
    description: "Get premium sports signal previews, market-source movement, confidence scoring, and early betting intelligence before odds shift.",
    url: "https://polypropicks.com",
    siteName: "PolyProPicks",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PolyProPicks — Premium Sports Signal Intelligence",
    description: "Premium sports signal previews and market-source movement before odds shift.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
