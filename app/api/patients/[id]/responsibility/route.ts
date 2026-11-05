import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { patientResponsibilitySettings, ResponsibilityError, type ResponsibilityTarget } from "@/lib/patient-responsibility-settings";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { commandCanonicalCaseResponsibility } from "@/lib/canonical-case-responsibility";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ id: string }> }, write: boolean) {
 // M2 slice 88b (owner decision G4-7): canonical sessions — the protected owner only.
 const selected = await selectRequestStaffEnvelope();
 if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401, headers: NO_STORE });
 const session = selected.kind === "canonical" ? null : await requireSession();
 if (selected.kind !== "canonical") {
  if (!session) return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ message: "تحديد الطبيب المسؤول للمدير فقط." }, { status: 403 });
 }
 try {
  const rawId = (await context.params).id;
  if (!/^[1-9]\d*$/.test(rawId) || Number(rawId) > 2147483647) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  const patientId = Number(rawId);
  const input = write ? await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES) : Object.fromEntries(new URL(request.url).searchParams);
  if (!input || !["clinical", "ortho"].includes(String(input.kind))) return NextResponse.json({ message: "مرجع الحالة غير صالح." }, { status: 400 });
  const target: ResponsibilityTarget = { patientId, kind: input.kind as "clinical" | "ortho", sourceId: Number(input.sourceId) };
  const command = write ? { expectedSourceFingerprint: typeof input.expectedSourceFingerprint === "string" ? input.expectedSourceFingerprint : "", doctorId: Number(input.doctorId), reason: typeof input.reason === "string" ? input.reason : "" } : undefined;
  const result = selected.kind === "canonical"
   ? await commandCanonicalCaseResponsibility(selected.handle, target, command)
   : await patientResponsibilitySettings(target, session!, command);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
 } catch (error) {
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  if (selected.kind === "canonical" && !(error instanceof ResponsibilityError)) return canonicalPatientReadFailure(error, "تعذّر تحديث المسؤولية. أعد المحاولة.");
  return NextResponse.json({ message: error instanceof ResponsibilityError ? error.message : "تعذّر تحديث المسؤولية. أعد المحاولة." }, { status: error instanceof ResponsibilityError ? error.status : 500 });
 }
}
export const GET = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, false);
export const PATCH = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, true);
