import { accessStatus } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The visitor's lane, its mode and the human check, for the browser (never cached). */
export async function GET(request: Request): Promise<Response> {
  return accessStatus(request);
}
