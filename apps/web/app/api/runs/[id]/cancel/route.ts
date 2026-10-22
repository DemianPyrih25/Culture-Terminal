import type { NextRequest } from "next/server";
import { cancelRun } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest, ctx: RouteContext<"/api/runs/[id]/cancel">): Promise<Response> {
  const { id } = await ctx.params;
  return cancelRun(id);
}
