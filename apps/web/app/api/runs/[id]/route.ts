import type { NextRequest } from "next/server";
import { runSnapshot } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/runs/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return runSnapshot(id);
}
