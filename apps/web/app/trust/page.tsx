import { permanentRedirect } from "next/navigation";
import { HOW_IT_WORKS_HREF } from "../../components/chrome/links";

/**
 * /trust moved: what we don't do is on /how-it-works, and the full rules (refusals, the audience
 * allowlist, data handling, models and caps) on /method. next.config.ts answers /trust with a 308
 * before this page is reached; the page is the same redirect, should the config ever lose it.
 */
export default function TrustPage(): never {
  permanentRedirect(HOW_IT_WORKS_HREF);
}
