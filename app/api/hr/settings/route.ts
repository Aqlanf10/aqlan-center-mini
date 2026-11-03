import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import {
  hrSettingsGetCanonicalResponse,
  hrSettingsPatchCanonicalResponse,
} from "@/lib/canonical-hr";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canManageStaff } from "@/lib/hr";
import { hrPayrollWriteAuthorizer } from "@/lib/hr-payroll-authority";
import { getPool } from "@/lib/db";
import { withIsolation } from "@/lib/transactions";
import { hrTemporalAuthority } from "@/lib/hr-temporal-authority";
import { HrHistoryError } from "@/lib/hr-temporal-request";
import { hrHistoryErrorResponse } from "@/lib/hr-temporal-http";
import {
  getHrSettings,
  updateHrSettings,
  HrPayrollError,
} from "@/lib/hr-payroll";
import type { HrSettings } from "@/lib/hr-payroll-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
const forbidden = () =>
  NextResponse.json({ message: "إعدادات الموارد البشرية للمدير وحده." }, { status: 403 });

export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return denied();
  if (selected.kind === "canonical") return hrSettingsGetCanonicalResponse(request, selected.handle);

  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  try {
    const authority = hrTemporalAuthority(session, request.signal);
    const settings = await withIsolation(getPool(), 'REPEATABLE READ', async client => {
      await authority.verify(client);
      const result = await getHrSettings(client);
      await authority.verify(client); authority.assertCurrent(); return result;
    });
    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof HrHistoryError) return hrHistoryErrorResponse(error);
    console.error("Failed to get HR settings:", error);
    return NextResponse.json({ message: "تعذّر جلب إعدادات الموارد البشرية." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return denied();
  if (selected.kind === "canonical") return hrSettingsPatchCanonicalResponse(request, selected.handle);

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

  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({message:"طلب غير صالح."},{status:400});
  const patch = body as Partial<HrSettings>;

  try {
    const updated = await updateHrSettings(patch, session, hrPayrollWriteAuthorizer(session));
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof HrPayrollError) return NextResponse.json({message:error.message,code:error.code},{status:error.status});
    console.error("Failed to update HR settings:", error);
    return NextResponse.json(
      { message: "تعذّر حفظ إعدادات الموارد البشرية." },
      { status: 500 }
    );
  }
}
