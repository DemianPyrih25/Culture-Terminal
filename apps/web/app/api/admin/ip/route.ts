import { adminIp } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The address headers this request arrived with, behind ADMIN_TOKEN (choosing CLIENT_IP_HEADER). */
export function GET(request: Request): Response {
  return adminIp(request);
}
