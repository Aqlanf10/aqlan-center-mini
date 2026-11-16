import { NextResponse } from "next/server";
import { readStaffAccount, updateStaffAccount } from "@/lib/staff-account-editor";
import { NO_STORE, canonicalEnvelopeOrResponse, canonicalErrorResponse } from "@/lib/canonical-route";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function targetId(context: Context): Promise<number | null> {
  const { id } = await context.params;
  return /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= 2147483647 ? Number(id) : null;
}
const INVALID_ID = () => NextResponse.json({ message: "رقم الموظف غير صالح." }, { status: 400, headers: NO_STORE });

/** حساب موظف للمحرّر (staff.view)، مع ما يحق للفاعل تغييره فيه. */
export async function GET(_request: Request, context: Context) {
  const handle = await canonicalEnvelopeOrResponse();
  if (handle instanceof NextResponse) return handle;
  const id = await targetId(context);
  if (id === null) return INVALID_ID();
  try {
    return NextResponse.json(await readStaffAccount(handle, id), { headers: NO_STORE });
  } catch (error) {
    return canonicalErrorResponse(error);
  }
}

/** تعديل حساب موظف: نسخة متوقّعة (CAS) + دفعة تغييرات تُرفض كاملة إن رُفض أي حقل منها. */
export async function PATCH(request: Request, context: Context) {
  const handle = await canonicalEnvelopeOrResponse();
  if (handle instanceof NextResponse) return handle;
  const id = await targetId(context);
  if (id === null) return INVALID_ID();
  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody<unknown>(request, FORM_BODY_LIMIT_BYTES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const { expectedVersion, changes } = body;
  if (typeof expectedVersion !== "string" || !changes || typeof changes !== "object" || Array.isArray(changes)
    || Object.keys(body).some(key => key !== "expectedVersion" && key !== "changes")) {
    return NextResponse.json({ message: "بيانات الحساب غير مكتملة." }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await updateStaffAccount(handle, { targetUserId: id, expectedVersion, changes: changes as Record<string, unknown> });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return canonicalErrorResponse(error);
  }
}
