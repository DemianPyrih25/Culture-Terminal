import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import type { DesType } from "@/components/des/des-href";
import type { DesOutcome } from "@/components/des/model";
import { getAccessService } from "@/server/access";
import { getDesService } from "@/server/des/wiring";

/**
 * The tearsheet for this request, computed once per request for the page and its metadata. The lane
 * comes from the judge cookie and the per-visitor limit from the salted address hash, as for runs.
 */
export const loadTearsheet = cache(async (name: string, type: DesType, pick: string | null): Promise<DesOutcome> => {
  // The handlers that read lanes and visitors take a Request; this one carries only the headers.
  const request = new Request("http://localhost/d", { headers: await headers() });
  const access = getAccessService();
  return getDesService().describe({ query: { name, type, pick }, lane: access.laneOf(request), visitor: access.clientKey(request) });
});
