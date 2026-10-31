import { SiteShell } from "../../components/chrome/site-shell";
import { HomeView } from "../../components/home/home-view";

/** Home (N01, N17): the statement, the question box, recent answers and follows. Signed-out visitors are sent to /login by the proxy. */
export default function Home() {
  return (
    <SiteShell header="home">
      <HomeView />
    </SiteShell>
  );
}
