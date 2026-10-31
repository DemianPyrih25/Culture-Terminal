import type { Metadata, Viewport } from "next";
// Ledger type: Source Serif 4 (optical-size cut) for titles, Inter for the interface, IBM Plex Mono for numbers.
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { publicSiteUrlFromEnv } from "../server/config";

export const metadata: Metadata = {
  // og:image and twitter:image need absolute URLs (a showcase's share card, lib/og/meta.ts).
  metadataBase: publicSiteUrlFromEnv(),
  title: "Culture Terminal",
  description: "Ask what any audience really loves. One-page answers from Qloo taste data, every number checked.",
};

// The design has one theme: light.
export const viewport: Viewport = { colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-canvas text-ink">{children}</body>
    </html>
  );
}
