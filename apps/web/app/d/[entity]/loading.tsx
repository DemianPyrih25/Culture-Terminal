import { SiteShell } from "../../../components/chrome/site-shell";
import { ProfileSkeleton } from "../../../components/des/profile-states";

/** While a profile is computed (a few seconds when its requests are not cached): skeleton cards. */
export default function DesLoading() {
  return (
    <SiteShell header="inner">
      <h1 className="sr-only">Loading the profile…</h1>
      <ProfileSkeleton />
    </SiteShell>
  );
}
