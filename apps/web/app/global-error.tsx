"use client";

// global-error replaces the root layout, so it brings its own document, styles and fonts.
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { LogoMark } from "../components/chrome/logo-mark";
import { ErrorCard } from "../components/status/error-card";

/**
 * When the app frame itself fails (Ledger V4vJ6k, bare page): no navigation and no app data, so nothing
 * on it can fail again. A plain wordmark, then the 500 card with Try again and Go to Ask.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <title>Something went wrong · Culture Terminal</title>
        <header className="flex h-14 items-center gap-2.5 border-b border-line px-6 max-md:px-4">
          <a href="/" className="flex items-center gap-2.5">
            <LogoMark size={22} />
            <span className="font-display text-[17px] leading-6 font-semibold tracking-[-0.01em] text-ink">Culture Terminal</span>
          </a>
        </header>
        <main className="flex flex-1 items-start justify-center px-4 py-24 max-md:py-10">
          <ErrorCard digest={error.digest} onRetry={retry} compact />
        </main>
      </body>
    </html>
  );
}
