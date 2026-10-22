import type { NextRequest } from "next/server";
import { streamRun } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/runs/[id]/stream">): Promise<Response> {
  const { id } = await ctx.params;
  return streamRun(request, id);
}
