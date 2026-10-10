import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  createContract,
  listContracts,
  type CreateContractInput,
} from "@/lib/hr-contracts-attendance";
import type { HrContractKind, HrContractStatus } from "@/lib/hr-contracts-attendance-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة العقود للمدير وحده." }, { status: 403 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const url = new URL(request.url);
  const staffIdStr = url.searchParams.get("staffId");
  const staffId = staffIdStr ? parseInt(staffIdStr, 10) : undefined;
  const status = (url.searchParams.get("status") as HrContractStatus) || undefined;
  const templateKind = (url.searchParams.get("contractKind") || url.searchParams.get("templateKind")) as any || undefined;

  try {
    const contracts = await listContracts({ staffId, status, templateKind });
    return NextResponse.json(contracts);
  } catch (error) {
    console.error("Failed to list contracts:", error);
    return NextResponse.json({ message: "تعذّر تحميل العقود." }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

  const payload = (body ?? {}) as Record<string, any>;
  if (!payload.staffId || !payload.title || !payload.startDate) {
    return NextResponse.json(
      { message: "يرجى تعبئة الحقول الإلزامية: الموظف، المسمى، وتاريخ البدء." },
      { status: 400 }
    );
  }

  try {
    const input: CreateContractInput = {
      staffId: Number(payload.staffId),
      templateKind: payload.templateKind || payload.contractKind || "support_staff",
      title: String(payload.title),
      startDate: String(payload.startDate),
      endDate: payload.endDate || null,
      probationEndDate: payload.probationEndDate || null,
      noticePeriodDays: payload.noticePeriodDays ? Number(payload.noticePeriodDays) : 30,
      termsPayload: payload.termsPayload || {},
      compensationKind: payload.compensationKind || "salary",
      baseSalaryMinor: payload.baseSalaryMinor ? Number(payload.baseSalaryMinor) : null,
      salaryCurrency: payload.salaryCurrency || payload.currency || null,
      salaryPeriod: payload.salaryPeriod || "monthly",
      commissionRatePercent: payload.commissionRatePercent ? Number(payload.commissionRatePercent) : null,
      doctorPartyId: payload.doctorPartyId ? Number(payload.doctorPartyId) : null,
      notes: payload.notes || null,
    };
    const contract = await createContract(input, session);
    return NextResponse.json(contract, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create contract:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إنشاء العقد." },
      { status: 400 }
    );
  }
}
