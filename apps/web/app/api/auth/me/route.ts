import { meResponse, updateMeResponse } from "@/server/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The signed-in user, or 401 with { user: null }. */
export async function GET(request: Request): Promise<Response> {
  return meResponse(request);
}

/** Changes the signed-in user's display name. */
export async function PATCH(request: Request): Promise<Response> {
  return updateMeResponse(request);
}
