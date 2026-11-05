import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSession } from "@/lib/session";
import { readInvoiceArchive, changeInvoiceArchive } from "@/lib/invoice-archive-db";
import { InvoiceArchiveError } from "@/lib/invoice-archive";

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
  try { const { id, session } = await owner(context); return NextResponse.json(await readInvoiceArchive(id, session)); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { id, session } = await owner(context);
    if (session.role !== "admin") throw new InvoiceArchiveError("unauthorized", "الأرشفة والاسترجاع للمدير وحده.");
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const result = await changeInvoiceArchive(id, body, session);
    return NextResponse.json(result, { status: result.replayed || result.noop ? 200 : 201 });
  } catch (error) { return failure(error); }
}
