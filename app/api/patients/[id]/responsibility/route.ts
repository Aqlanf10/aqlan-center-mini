import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { patientResponsibilitySettings, ResponsibilityError, type ResponsibilityTarget } from "@/lib/patient-responsibility-settings";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ id: string }> }, write: boolean) {
 const session = await requireSession();
 if (!session) return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
 // No role-name gate: the library decides from the actor's current grants and patient access, inside its transaction.
 try {
  const rawId = (await context.params).id;
  if (!/^[1-9]\d*$/.test(rawId) || Number(rawId) > 2147483647) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  const patientId = Number(rawId);
  const input = write ? await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES) : Object.fromEntries(new URL(request.url).searchParams);
  if (!input || !["clinical", "ortho"].includes(String(input.kind))) return NextResponse.json({ message: "مرجع الحالة غير صالح." }, { status: 400 });
  const target: ResponsibilityTarget = { patientId, kind: input.kind as "clinical" | "ortho", sourceId: Number(input.sourceId) };
  const result = await patientResponsibilitySettings(target, session, write ? { expectedSourceFingerprint: typeof input.expectedSourceFingerprint === "string" ? input.expectedSourceFingerprint : "", doctorId: Number(input.doctorId), reason: typeof input.reason === "string" ? input.reason : "" } : undefined);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
 } catch (error) {
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  return NextResponse.json({ message: error instanceof ResponsibilityError ? error.message : "تعذّر تحديث المسؤولية. أعد المحاولة." }, { status: error instanceof ResponsibilityError ? error.status : 500 });
 }
}
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, false);
export const PATCH = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, true);
