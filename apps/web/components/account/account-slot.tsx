import Link from "next/link";
import { currentUser } from "../../server/auth/current";
import { SignOutButton } from "./sign-out-button";

/**
 * The signed-in person at the foot of the sidebar: initial, name (to /settings/account) and Sign out.
 * A server component; renders nothing when no one is signed in.
 */
export async function AccountSlot() {
  const user = await currentUser();
  if (!user) return null;
  const initial = (user.name.trim()[0] ?? user.email[0] ?? "?").toUpperCase();
  return (
    <div className="flex items-center gap-2.5" data-testid="account-slot">
      <span aria-hidden="true" className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent-ink">
        {initial}
      </span>
      <Link href="/settings/account" className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink hover:underline" title={user.email}>
        {user.name}
      </Link>
      <SignOutButton />
    </div>
  );
}
