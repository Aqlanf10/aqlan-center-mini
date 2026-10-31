import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { linkFamilyMemberCanonicalResponse } from "@/lib/canonical-patient-finance-history";
import { linkPatientToFamily } from "@/lib/db";
import { idOf, json, readBody } from "@/lib/case-route";
import { familyFailure, familyResponse, familyWriter } from "@/lib/family-route";
import { parseFamilyRole } from "@/lib/patient-families";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";

export const dynamic = "force-dynamic";

/** (PAT-4) ربط مريضٍ بالعائلة بصلته — أو تغيير صلته إن كان من أفرادها. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return linkFamilyMemberCanonicalResponse(selected.handle, request, (await params).id);
  const guard = await familyWriter();
  if (!guard.ok) return guard.response;
  const familyId = idOf((await params).id);
  if (!familyId) return json("رقم العائلة غير صالح.", 400);
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const patientId = idOf(String(read.body.patientId ?? ""));
  if (!patientId) return json("اختر المريض الذي يُربط بالعائلة.", 400);
  const role = parseFamilyRole(read.body.role);
  if (!role.ok) return json(role.message, 400);
  try {
    const result = await linkPatientToFamily({ familyId, patientId, role: role.value }, { actor: guard.session.username, actorRole: guard.session.role });
    if (!result.ok) return familyFailure(result.reason);
    return familyResponse(guard.session, result.family);
  } catch {
    return json("تعذّر ربط المريض بالعائلة. أعد المحاولة.", 500);
  }
}
