import type { ReactNode } from "react";

/** The landing's own frame: no app sidebar or header, the page brings its nav and footer. */
export default function WelcomeLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
