import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";
import { publicSiteUrlFromEnv } from "../server/config";

export const metadata: Metadata = {
  // og:image and twitter:image need absolute URLs (a showcase's share card, lib/og/meta.ts).
  metadataBase: publicSiteUrlFromEnv(),
  title: "Culture Terminal",
  description: "Taste intelligence for investors: one-page briefs grounded in Qloo taste data, every number traced to its request.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
