import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import { disbursePayrollItem, disburseEntireRun, findDisbursementByRequestId, reversePayrollDisbursement, HrPayrollError, type DisburseInput } from "@/lib/hr-payroll";
export const dynamic = "force-dynamic";
const denied = (status: number) => NextResponse.json({ message: status === 401 ? "انتهت الجلسة. سجّل الدخول من جديد." : "صرف الرواتب والمستحقات للمدير وحده." }, { status });
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied(401);
  if (!canManageStaff(session.role)) return denied(403);
  const key = new URL(request.url).searchParams.get("clientRequestId");
  if (!key || key.length < 8 || key.length > 100) return NextResponse.json({ message: "مفتاح الطلب غير صالح." }, { status: 400 });
  try {
    const disbursement = await findDisbursementByRequestId(key);
    return NextResponse.json({ disbursement });
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من نتيجة الصرف؛ أعد المحاولة بالمفتاح نفسه." }, { status: 503 });
  }
}
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied(401);
  if (!canManageStaff(session.role)) return denied(403);
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) { return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  const p = body as Record<string, unknown>;
  try {
    if (p.action === "reverse") {
      if (typeof p.reason !== "string" || !(typeof p.disbursementId === "string" || typeof p.disbursementId === "number")) throw new HrPayrollError("invalid_reversal",400,"حدّد حركة الصرف وسبب العكس.");
      return NextResponse.json({ success: true, disbursement: await reversePayrollDisbursement(p.disbursementId,{ reason:p.reason },session) });
    }
    if (p.action && p.action !== "disburse") throw new HrPayrollError("invalid_action",400,"العملية غير صالحة.");
    if (typeof p.clientRequestId !== "string" || !p.clientRequestId.trim()) throw new HrPayrollError("request_key_required",400,"مفتاح الطلب الثابت مطلوب للصرف.");
    for (const name of ["paymentMethod","referenceNumber","notes","safeOrBankId"]) if (p[name] != null && typeof p[name] !== "string") throw new HrPayrollError("invalid_input",400,"بيانات الصرف غير صالحة.");
    if (p.amountMinor !== undefined && typeof p.amountMinor !== "number") throw new HrPayrollError("invalid_amount",400,"المبلغ غير صالح.");
    if (p.components != null && (typeof p.components !== "object" || Array.isArray(p.components))) throw new HrPayrollError("invalid_components",400,"توزيع الصرف غير صالح.");
    const input: DisburseInput = { amountMinor:p.amountMinor as number | undefined, clientRequestId:p.clientRequestId,
      components:p.components as DisburseInput["components"], paymentMethod:p.paymentMethod as string | undefined,
      referenceNumber:p.referenceNumber as string | null, notes:p.notes as string | null, safeOrBankId:p.safeOrBankId as string | null };
    if (p.disburseAll === true) {
      if (!(typeof p.runId === "number" || typeof p.runId === "string")) throw new HrPayrollError("invalid_id",400,"حدّد مسير الرواتب.");
      return NextResponse.json({ success:true,disbursements:await disburseEntireRun(p.runId,input,session) },{ status:201 });
    }
    if (!(typeof p.itemId === "number" || typeof p.itemId === "string")) throw new HrPayrollError("invalid_id",400,"حدّد بند المستحق.");
    const disbursement = await disbursePayrollItem(p.itemId,input,session);
    return NextResponse.json({ success:true,disbursement },{ status:disbursement.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof HrPayrollError) return NextResponse.json({ message:error.message,code:error.code },{ status:error.status });
    console.error("HR disbursement unresolved",error);
    return NextResponse.json({ message:"لم تتأكد نتيجة الصرف؛ تحقق أو أعد الطلب نفسه بالمفتاح نفسه.",code:"outcome_uncertain" },{ status:503 });
  }
}
