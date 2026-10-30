import { postScreener } from "@/server/screener/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs a brand screen (PLAN §5.5); see server/screener/http.ts. */
export async function POST(request: Request): Promise<Response> {
  return postScreener(request);
}
