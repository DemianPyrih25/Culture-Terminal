import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteShell } from "../components/chrome/site-shell";
import { HomeView } from "../components/home/home-view";
import { LANDING_META, LandingPage } from "../components/landing";
import { currentUser } from "../server/auth/current";
import { authRequired } from "../server/auth/session";

// Per request: what "/" shows depends on the visitor's session cookie.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: LANDING_META.title,
  description: LANDING_META.description,
};

/**
 * "/": the landing for signed-out visitors; signed-in people go straight to /home. With AUTH_REQUIRED=0
 * (no sign-in gate, e.g. the mock e2e smoke) "/" stays the question page it was before accounts.
 */
export default async function Root() {
  if (!authRequired()) {
    return (
      <SiteShell header="home">
        <HomeView />
      </SiteShell>
    );
  }
  if (await currentUser()) redirect("/home");
  return <LandingPage />;
}
