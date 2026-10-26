import { MetroId } from "@ct/contracts";
import { outlinesResponse } from "../outlines";

// Neighbourhood outlines for the LiftMap: static per build, one response per metro.
export const runtime = "nodejs";
export const dynamicParams = false;

export function generateStaticParams(): { metro: string }[] {
  return MetroId.options.map((metro) => ({ metro }));
}

export async function GET(_request: Request, ctx: RouteContext<"/api/geo/[metro]">): Promise<Response> {
  const { metro } = await ctx.params;
  return outlinesResponse(metro);
}
