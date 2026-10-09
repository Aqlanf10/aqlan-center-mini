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
  const staffId = url.searchParams.get("staffId") || undefined;
  const status = (url.searchParams.get("status") as HrContractStatus) || undefined;
  const contractKind = (url.searchParams.get("contractKind") as HrContractKind) || undefined;

  try {
    const contracts = await listContracts({ staffId, status, contractKind });
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

  const payload = (body ?? {}) as Partial<CreateContractInput>;
  if (!payload.staffId || !payload.contractNumber || !payload.title || !payload.startDate || !payload.currency) {
    return NextResponse.json(
      { message: "يرجى تعبئة الحقول الإلزامية: الموظف، رقم العقد، المسمى، تاريخ البدء، والعملة." },
      { status: 400 }
    );
  }

  try {
    const contract = await createContract(payload as CreateContractInput, session);
    return NextResponse.json(contract, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create contract:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إنشاء العقد." },
      { status: 400 }
    );
  }
}
