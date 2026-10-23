import { listRecentRuns, startRun } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The showcases and the runs named in ?ids= (this browser's own), never other visitors' runs (D31). */
export async function GET(request: Request): Promise<Response> {
  return listRecentRuns(request);
}

export async function POST(request: Request): Promise<Response> {
  return startRun(request);
}
