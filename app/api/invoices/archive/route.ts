import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { listInvoiceArchive } from "@/lib/invoice-archive-db";
import { InvoiceArchiveError } from "@/lib/invoice-archive";
import { canViewMoney } from "@/lib/roles";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
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
