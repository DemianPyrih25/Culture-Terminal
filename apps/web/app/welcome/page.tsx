import type { Metadata } from "next";
import { LANDING_META, LandingPage } from "../../components/landing";

export const metadata: Metadata = {
  title: LANDING_META.title,
  description: LANDING_META.description,
};

/** /welcome, the marketing landing for business buyers. Calls to action lead to /signup and /login. */
export default function WelcomePage() {
  return <LandingPage />;
}
