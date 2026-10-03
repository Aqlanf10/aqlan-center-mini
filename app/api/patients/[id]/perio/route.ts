import { NextResponse } from "next/server";
import { guardPatient, idOf, json } from "@/lib/case-route";
import { listPatientPerio } from "@/lib/periodontics-db";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const patientId = idOf((await params).id);
  if (!patientId) return json("رقم مريض غير صالح.", 400);
  const guard = await guardPatient(patientId, false);
  if (!guard.ok) return guard.response;
  try { return NextResponse.json({ exams: await listPatientPerio(patientId) }); }
  catch { return json("تعذّر تحميل فحوص اللثة. أعد المحاولة.", 500); }
}
