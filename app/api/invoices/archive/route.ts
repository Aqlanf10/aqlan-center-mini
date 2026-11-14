import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalInvoiceArchiveList } from "@/lib/canonical-invoice-reads";
import { listInvoiceArchive } from "@/lib/invoice-archive-db";
import { InvoiceArchiveError } from "@/lib/invoice-archive";
import { canViewMoney } from "@/lib/roles";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  // M2 slice 92: finance.invoices.view inside the patient scope, one snapshot.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalInvoiceArchiveList(selected.handle, Number(new URL(request.url).searchParams.get("patientId"))), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل أرشيف الفواتير."); }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة؛ سجّل الدخول من جديد." }, { status: 401 });
  if (!canViewMoney(session.role)) return NextResponse.json({ message: "الأرشيف يحتاج صلاحية قراءة الفواتير." }, { status: 403 });
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isSafeInteger(patientId) || patientId <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  try { return NextResponse.json(await listInvoiceArchive(patientId, session)); }
  catch (error) {
    if (error instanceof InvoiceArchiveError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.code === "unauthorized" ? 403 : 409 });
    return NextResponse.json({ message: "تعذّر تحميل أرشيف الفواتير." }, { status: 500 });
  }
}
