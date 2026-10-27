import type { Metadata, Viewport } from "next";
// The optical-size cut: display sizes draw tighter, as the design sets them.
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
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
