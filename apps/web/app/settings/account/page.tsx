import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AccountSettings } from "../../../components/account/account-settings";
import { SiteShell } from "../../../components/chrome/site-shell";
import { SettingsLayout } from "../../../components/settings/settings-nav";
import { currentUser } from "../../../server/auth/current";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account · Culture Terminal",
  description: "Your name, sign-in email and password.",
  robots: { index: false, follow: false },
};

/** /settings/account: the signed-in person's profile, password and sign out. */
export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=%2Fsettings%2Faccount");
  return (
    <SiteShell header="inner">
      <SettingsLayout active="account">
        <AccountSettings account={{ name: user.name, email: user.email, createdAt: user.createdAt.toISOString() }} />
      </SettingsLayout>
    </SiteShell>
  );
}
