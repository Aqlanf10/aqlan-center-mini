import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { changeNumberingFloor, readNumberingPreview } from "@/lib/patient-numbering-db";
import { patientNumberingErrorResponse } from "@/lib/patient-numbering-response";
export const dynamic = "force-dynamic";
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لإعداد الترقيم."}, {status: 403});
  try { return NextResponse.json(await readNumberingPreview(session), {headers: {"Cache-Control": "no-store"}}); }
  catch (error) { return patientNumberingErrorResponse(error); }
}
export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لإعداد الترقيم."}, {status: 403});
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({message: "الطلب غير صالح."}, {status: 400});
    const input = body as Record<string, unknown>;
    return NextResponse.json(await changeNumberingFloor(session, {minimumNext: input.minimumNext,
      expectedVersion: input.expectedVersion, expectedNextNumber: input.expectedNextNumber, reason: input.reason}));
  } catch (error) { return bodyErrorResponse(error) ?? patientNumberingErrorResponse(error); }
}
