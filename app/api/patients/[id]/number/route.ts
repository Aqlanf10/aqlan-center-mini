import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { changePatientNumber, readPatientNumber } from "@/lib/patient-numbering-db";
import { patientNumberingErrorResponse } from "@/lib/patient-numbering-response";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{id: string}>};
export async function GET(_request: Request, context: Context) {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لتعديل أرقام الملفات."}, {status: 403});
  try { return NextResponse.json(await readPatientNumber(session, Number((await context.params).id)), {headers: {"Cache-Control": "no-store"}}); }
  catch (error) { return patientNumberingErrorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لتعديل أرقام الملفات."}, {status: 403});
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({message: "الطلب غير صالح."}, {status: 400});
    const input = body as Record<string, unknown>;
    return NextResponse.json(await changePatientNumber(session, Number((await context.params).id), {
      patientNumber: input.patientNumber, expectedPatientNumber: input.expectedPatientNumber,
      expectedVersion: input.expectedVersion, reason: input.reason,
    }));
  } catch (error) { return bodyErrorResponse(error) ?? patientNumberingErrorResponse(error); }
}
