import { NextResponse } from "next/server";
import { requireSession } from "./session";
import { canAccessPatient } from "./patient-access";
export type JourneyRouteContext = { params: Promise<{ id: string }> };
export const journeyResponse = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export const journeyRouteError = (status: number, code: string, message = "تعذّر التحقق من الطلب أو صلاحيات الحالة.") => journeyResponse({ ok: false, code, message }, status);
export function routeId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw); return Number.isSafeInteger(n) ? n : null;
}
/** Nonlocking route admission. The store independently revalidates under locks. */
export async function admitJourney(write: boolean) {
  const session = await requireSession();
  if (!session) return { ok: false as const, response: journeyRouteError(401, "session_expired") };
  if (session.role !== "admin" && session.role !== "doctor" && session.role !== "reception"
    || write && session.role === "reception") return { ok: false as const, response: journeyRouteError(403, "clinical_access_denied") };
  return { ok: true as const, session };
}
export async function journeyRouteOwner(context: JourneyRouteContext, patientId: number, session: NonNullable<Awaited<ReturnType<typeof requireSession>>>) {
  const orthoCaseId = routeId((await context.params).id);
  if (!orthoCaseId || !Number.isSafeInteger(patientId) || patientId <= 0) return { ok: false as const, response: journeyRouteError(400, "invalid_scope") };
  if (!await canAccessPatient(session, patientId).catch(() => false)) return { ok: false as const, response: journeyRouteError(403, "patient_access_denied") };
  return { ok: true as const, session, patientId, orthoCaseId };
}
export function parseJourneyBody(body: unknown): { patientId: number; command: unknown } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).length !== 2 || !Object.prototype.hasOwnProperty.call(b, "command")
    || typeof b.patientId !== "number" || !Number.isSafeInteger(b.patientId) || b.patientId <= 0) return null;
  return { patientId: b.patientId, command: b.command };
}
