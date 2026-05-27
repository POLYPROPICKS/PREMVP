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
  icons: {
    icon: [
      { url: "/brand/logo/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/logo/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/logo/favicon-48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: { url: "/brand/logo/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  manifest: "/brand/logo/manifest.webmanifest",
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
