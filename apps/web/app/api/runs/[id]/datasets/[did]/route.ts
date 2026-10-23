import type { NextRequest } from "next/server";
import { runDataset } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/runs/[id]/datasets/[did]">): Promise<Response> {
  const { id, did } = await ctx.params;
  return runDataset(id, did);
}
