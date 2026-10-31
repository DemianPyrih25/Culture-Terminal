"use client";

import { useState } from "react";
import { Button, type ButtonVariant } from "../ui/button";

/** Ends the session, then goes to the landing page. */
export function SignOutButton({ variant = "quiet", className }: { variant?: ButtonVariant; className?: string }) {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may survive a failed request; the landing page shows whether the visitor is still signed in.
    }
    window.location.assign("/");
  }
  return (
    <Button variant={variant} size="sm" trailing={null} loading={busy} disabled={busy} onClick={signOut} className={className} data-testid="sign-out">
      {busy ? "Signing out…" : "Sign out"}
    </Button>
  );
}
