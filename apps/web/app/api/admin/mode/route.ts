import { adminMode } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stored mode and each lane's decision, behind ADMIN_TOKEN. */
export async function GET(request: Request): Promise<Response> {
  return adminMode(request);
}

/** Stores a mode ({mode, reason?}), behind ADMIN_TOKEN. */
export async function POST(request: Request): Promise<Response> {
  return adminMode(request);
}
