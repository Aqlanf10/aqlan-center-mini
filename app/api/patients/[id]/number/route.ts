import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
export const dynamic = "force-dynamic";
/** Retained refusal boundary for old clients. Middleware still enforces CSRF;
 * authenticate before the explicit refusal, never execute a numbering command. */
export async function PATCH() {
  const session = await requireSession();
  if (!session) return NextResponse.json({message: "سجّل الدخول من جديد."}, {status: 401});
  if (!isAdmin(session.role)) return NextResponse.json({message: "لا توجد صلاحية لتعديل أرقام الملفات."}, {status: 403});
  return NextResponse.json({code: "number_edit_deferred", message: "تعديل أرقام الملفات الحالية مؤجل؛ الترقيم الجديد يخص المرضى الجدد فقط."},
    {status: 403, headers: {"Cache-Control": "no-store"}});
}
