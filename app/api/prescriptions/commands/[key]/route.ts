import { NextResponse } from "next/server";
import { readSessionPayload } from "@/lib/session";
import { recoverPrescriptionCommand } from "@/lib/prescription-issuance";
import { validPrescriptionCommandKey } from "@/lib/prescription-command";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const session = await readSessionPayload();
  if (!session?.credentialVersion) return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401 });
  const { key } = await context.params;
  const query = new URL(request.url).searchParams;
  const patientId = Number(query.get("patientId")), prescribingDoctorPartyId = Number(query.get("prescribingDoctorPartyId"));
  const visitId = query.has("visitId") ? Number(query.get("visitId")) : null;
  if (!validPrescriptionCommandKey(key) || !Number.isSafeInteger(patientId) || patientId <= 0 || !Number.isSafeInteger(prescribingDoctorPartyId) || prescribingDoctorPartyId <= 0 || (visitId !== null && (!Number.isSafeInteger(visitId) || visitId <= 0)))
    return NextResponse.json({ message: "سياق الإصدار غير صالح." }, { status: 400 });
  const response = await recoverPrescriptionCommand(session, key, { patientId, visitId, prescribingDoctorPartyId });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
