import { SiteShell } from "../components/chrome/site-shell";
import { HomeView } from "../components/home/home-view";

/** Home (N01, N17): the hero, the question box and the how band. Nothing is read on the server. */
export default function Home() {
  return (
    <SiteShell header="home">
      <HomeView />
    </SiteShell>
  );
}
