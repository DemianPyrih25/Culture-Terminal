import { getRunManager } from "@/server/container";
import { health } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health, with the run queue's depth (D24, PLAN §10.3 runs.queued): agent runs waiting for a
 * slot in this process. Added to `runs` only where health could read the run manager.
 */
export async function GET(): Promise<Response> {
  const res = await health();
  const body = (await res.json()) as { runs?: Record<string, unknown> | null };
  if (body.runs) {
    try {
      body.runs.queued = getRunManager().queuedCount();
    } catch {
      body.runs.queued = null;
    }
  }
  return Response.json(body, { status: res.status, headers: res.headers });
}
