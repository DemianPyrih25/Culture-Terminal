import type { Metadata } from "next";
import { LANDING_META, LandingPage } from "../../components/landing";

export const metadata: Metadata = {
  title: LANDING_META.title,
  description: LANDING_META.description,
};

/** /welcome, the marketing landing for business buyers. Static; every call to action leads to Home. */
export default function WelcomePage() {
  return <LandingPage />;
}
