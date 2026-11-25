import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { routeId, type JourneyRouteContext } from "@/lib/ortho-journey-route";
import { orthoQuery } from "@/lib/ortho-route-handler";
import { canBookOrthoAdjustmentReturn } from "@/lib/ortho-adjustment-booking-authority";
import { readOrthoAdjustmentBookingContext } from "@/lib/ortho-adjustment-booking-context";
import { ORTHO_RETURN_REVIEW_MESSAGE } from "@/lib/ortho-adjustment-booking-contract";

export const dynamic = "force-dynamic";
const reply = (data: object, status: number) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request, context: JourneyRouteContext) {
  const session = await requireSession();
  if (!session) return reply({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  const query = orthoQuery(request, ["patientId", "adjustmentId"]);
  const patientId = routeId(query?.get("patientId") ?? null);
  const adjustmentId = routeId(query?.get("adjustmentId") ?? null);
  const caseId = routeId((await context.params).id);
  if (!query || !patientId || !adjustmentId || !caseId) return reply({ message: ORTHO_RETURN_REVIEW_MESSAGE }, 400);
  try {
    if (!await canBookOrthoAdjustmentReturn(session, patientId)) return reply({ message: ORTHO_RETURN_REVIEW_MESSAGE }, 403);
    await ensureSchema();
    const result = await readOrthoAdjustmentBookingContext(getPool(), { patientId, caseId, adjustmentId });
    return result.ok ? reply(result, 200) : reply({ message: ORTHO_RETURN_REVIEW_MESSAGE }, 404);
  } catch {
    return reply({ message: ORTHO_RETURN_REVIEW_MESSAGE }, 503);
  }
}
