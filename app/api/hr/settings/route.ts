import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  getHrSettings,
  updateHrSettings,
} from "@/lib/hr-payroll";
import type { HrSettings } from "@/lib/hr-payroll-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إعدادات الموارد البشرية للمدير وحده." }, { status: 403 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  try {
    const settings = await getHrSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error("Failed to get HR settings:", error);
    return NextResponse.json({ message: "تعذّر جلب إعدادات الموارد البشرية." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const patch = (body ?? {}) as Partial<HrSettings>;

  try {
    const updated = await updateHrSettings(patch, session);
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Failed to update HR settings:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر حفظ إعدادات الموارد البشرية." },
      { status: 400 }
    );
  }
}
