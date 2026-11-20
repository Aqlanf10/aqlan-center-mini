import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { readNumberingPreview } from "@/lib/patient-numbering-db";
import { patientNumberingErrorResponse } from "@/lib/patient-numbering-response";
export const dynamic = "force-dynamic";
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لإعداد الترقيم."}, {status: 403});
  try { return NextResponse.json(await readNumberingPreview(session), {headers: {"Cache-Control": "no-store"}}); }
  catch (error) { return patientNumberingErrorResponse(error); }
}
