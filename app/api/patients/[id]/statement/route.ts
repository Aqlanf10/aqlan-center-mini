import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { canViewMoney } from "@/lib/roles";
import { financeAccessFor } from "@/lib/finance-permissions";
import { loadPatientStatementDocument } from "@/lib/patient-statement-build";
import { parsePatientStatementOptions, StatementInputError } from "@/lib/patient-statement-options";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers });
  if (!canViewMoney(session.role) || ((session.role === "cashier" || session.role === "accountant")
    && !financeAccessFor(session.role, session.financeAccess).viewPatientLedger)) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على كشف حساب المريض." }, { status: 403, headers });
  }
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers });
  try {
    const options = parsePatientStatementOptions(new URL(request.url).searchParams, id);
    const document = await loadPatientStatementDocument(id, options);
    if (!document) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404, headers });
    return NextResponse.json(document, { headers });
  } catch (error) {
    return NextResponse.json({ message: error instanceof StatementInputError ? error.message : "تعذّر تحميل كشف الحساب. أعد المحاولة قبل الطباعة أو المشاركة." },
      { status: error instanceof StatementInputError ? 400 : 500, headers });
  }
}
