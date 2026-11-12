import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalInvoiceArchive } from "@/lib/canonical-invoice-reads";
import { readInvoiceArchive, changeInvoiceArchive } from "@/lib/invoice-archive-db";
import { InvoiceArchiveError } from "@/lib/invoice-archive";
import { commandCanonicalInvoiceArchive } from "@/lib/canonical-invoice-corrections";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
function failure(error: unknown) {
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  if (error instanceof InvoiceArchiveError) return NextResponse.json({ code: error.code, message: error.message, ...(error.refusal ? { refusal: error.refusal } : {}) },
    { status: error.code === "unauthorized" ? 403 : error.code === "missing" ? 404 : error.code === "invalid" ? 400 : 409 });
  return NextResponse.json({ message: "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق." }, { status: 500 });
}
async function owner(context: Context) {
  const session = await requireSession();
  if (!session) throw new InvoiceArchiveError("unauthorized", "انتهت الجلسة؛ سجّل الدخول من جديد.");
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvoiceArchiveError("invalid", "رقم الفاتورة غير صالح.");
  return { id, session };
}
export async function GET(_request: Request, context: Context) {
  // M2 slice 92: finance.invoices.view; an invoice outside the patient scope reads like a missing one.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalInvoiceArchive(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل حالة أرشفة الفاتورة."); }
  }
  try { const { id, session } = await owner(context); return NextResponse.json(await readInvoiceArchive(id, session)); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  // M2 slice 93c (G4-8): archive or restore by finance.invoices.cancel inside the patient scope.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const result = await commandCanonicalInvoiceArchive(selected.handle, (await context.params).id, await readJsonBody(request, JSON_BODY_LIMIT_BYTES));
      return NextResponse.json(result, { status: result.replayed || result.noop ? 200 : 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof InvoiceArchiveError || bodyErrorResponse(error)) { const response = failure(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
      return canonicalPatientReadFailure(error, "تعذّر تأكيد حالة الأرشفة؛ احتفظ بالطلب نفسه وأعد التحقق.");
    }
  }
  try {
    const { id, session } = await owner(context);
    if (session.role !== "admin") throw new InvoiceArchiveError("unauthorized", "الأرشفة والاسترجاع للمدير وحده.");
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const result = await changeInvoiceArchive(id, body, session);
    return NextResponse.json(result, { status: result.replayed || result.noop ? 200 : 201 });
  } catch (error) { return failure(error); }
}
