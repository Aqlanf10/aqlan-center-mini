import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { changePatientNumber, readPatientNumber } from "@/lib/patient-numbering-db";
import { patientNumberingErrorResponse } from "@/lib/patient-numbering-response";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import {
  canonicalEndoVisitFailure,
  changeCanonicalPatientNumber,
  readCanonicalPatientNumber,
} from "@/lib/canonical-endo-visits";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{id: string}>};
export async function GET(_request: Request, context: Context) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401, headers: NO_STORE});
  if (selected.kind === "canonical") {
    try {
      return NextResponse.json(
        await readCanonicalPatientNumber(selected.handle, Number((await context.params).id)),
        {headers: {"Cache-Control": "no-store"}},
      );
    } catch (error) {
      return canonicalEndoVisitFailure(error, "تعذّر تحميل رقم الملف.");
    }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لتعديل أرقام الملفات."}, {status: 403});
  try { return NextResponse.json(await readPatientNumber(session, Number((await context.params).id)), {headers: {"Cache-Control": "no-store"}}); }
  catch (error) { return patientNumberingErrorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401, headers: NO_STORE});
  if (selected.kind === "canonical") {
    try {
      const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({code: "invalid", message: "الطلب غير صالح."}, {status: 400, headers: NO_STORE});
      }
      const input = body as Record<string, unknown>;
      return NextResponse.json(
        await changeCanonicalPatientNumber(selected.handle, Number((await context.params).id), {
          patientNumber: input.patientNumber,
          expectedPatientNumber: input.expectedPatientNumber,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          ...(input.allowPaperArchiveOverride === true ? { allowPaperArchiveOverride: true } : {}),
        }),
        {headers: NO_STORE},
      );
    } catch (error) {
      return bodyErrorResponse(error) ?? canonicalEndoVisitFailure(error, "تعذّر تعديل رقم الملف.");
    }
  }
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
      ...(input.allowPaperArchiveOverride === true ? { allowPaperArchiveOverride: true } : {}),
    }));
  } catch (error) { return bodyErrorResponse(error) ?? patientNumberingErrorResponse(error); }
}
