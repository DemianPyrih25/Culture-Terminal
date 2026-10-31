import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "../../components/account/auth-form";
import { AuthLayout } from "../../components/account/auth-layout";
import { currentUser } from "../../server/auth/current";
import { safeNext } from "../../server/auth/validate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Create account · Culture Terminal",
  description: "Create your Culture Terminal account.",
  robots: { index: false, follow: false },
};

/** /signup (D9e5SY). A signed-in visitor goes straight to `next`. */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  if (await currentUser()) redirect(next);
  return (
    <AuthLayout
      eyebrow="Create account"
      title="Set up your workspace"
      lead="Ask about brands, places and audiences. Every answer shows its sources and how sure it is."
    >
      <AuthForm mode="signup" next={next} />
    </AuthLayout>
  );
}
