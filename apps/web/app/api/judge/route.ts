import { judgeLink } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The judge link: ?token=<JUDGE_TOKEN> opens the judge lane in this browser. */
export async function GET(request: Request): Promise<Response> {
  return judgeLink(request);
}
