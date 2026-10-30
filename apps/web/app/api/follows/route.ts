import { createFollowResponse, deleteFollowResponse, listFollowsResponse, setFollowLatestResponse } from "@/server/follows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This browser's follows with their latest notes (never another visitor's: D31). */
export async function GET(request: Request): Promise<Response> {
  return listFollowsResponse(request);
}

/** Follows a note's brand, place or question, or a profile's brand; behind the human check (§10.3). */
export async function POST(request: Request): Promise<Response> {
  return createFollowResponse(request);
}

/** Points a follow at the re-run it started, once that run has a note. */
export async function PATCH(request: Request): Promise<Response> {
  return setFollowLatestResponse(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return deleteFollowResponse(request);
}
