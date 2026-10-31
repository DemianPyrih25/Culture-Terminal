import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "../../components/account/auth-form";
import { AuthLayout } from "../../components/account/auth-layout";
import { currentUser } from "../../server/auth/current";
import { safeNext } from "../../server/auth/validate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · Culture Terminal",
  description: "Sign in to your Culture Terminal workspace.",
  robots: { index: false, follow: false },
};

/** /login (B9vRTo). A signed-in visitor goes straight to `next`. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  if (await currentUser()) redirect(next);
  return (
    <AuthLayout eyebrow="Sign in" title="Welcome back" lead="Sign in to see your answers, the brands and places you follow, and to ask new questions.">
      <AuthForm mode="login" next={next} />
    </AuthLayout>
  );
}
