import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { canManageStaff } from "@/lib/hr";
import {
  getContractById,
  updateContract,
  transitionContractStatus,
  createContractAddendum,
  listContractAddenda,
  type UpdateContractInput,
  type CreateAddendumInput,
} from "@/lib/hr-contracts-attendance";
import type { HrContractStatus } from "@/lib/hr-contracts-attendance-shared";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة العقود للمدير وحده." }, { status: 403 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const { id } = await params;
  try {
    const contract = await getContractById(id);
    if (!contract) {
      return NextResponse.json({ message: "العقد غير موجود." }, { status: 404 });
    }
    const addenda = await listContractAddenda(id);
    return NextResponse.json({ contract, addenda });
  } catch (error) {
    console.error("Failed to get contract:", error);
    return NextResponse.json({ message: "تعذّر جلب العقد." }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const { id } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, any>;

  try {
    if (payload.action === "transition") {
      const { status, reason } = payload as { status: HrContractStatus; reason?: string };
      if (!status) {
        return NextResponse.json({ message: "يرجى تحديد الحالة الجديدة." }, { status: 400 });
      }
      const updated = await transitionContractStatus(id, status, reason || "تحديث حالة العقد", session);
      return NextResponse.json(updated);
    } else {
      const updated = await updateContract(id, payload as UpdateContractInput, session);
      return NextResponse.json(updated);
    }
  } catch (error: any) {
    console.error("Failed to update contract:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر تحديث العقد." },
      { status: 400 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageStaff(session.role)) return forbidden();

  const { id } = await params;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, any>;
  if (!payload.title || !payload.startDate || (!payload.addendumReason && !payload.reason)) {
    return NextResponse.json(
      { message: "يرجى تعبئة عنوان الملحق وتاريخ السريان وسبب التعديل." },
      { status: 400 }
    );
  }

  try {
    const input: CreateAddendumInput = {
      title: String(payload.title),
      startDate: String(payload.startDate || payload.effectiveDate),
      endDate: payload.endDate || null,
      addendumReason: String(payload.addendumReason || payload.reason || "تعديل بنود العقد"),
      termsPayload: payload.termsPayload || {},
      baseSalaryMinor: payload.baseSalaryMinor !== undefined ? Number(payload.baseSalaryMinor) : undefined,
      salaryCurrency: payload.salaryCurrency || undefined,
      salaryPeriod: payload.salaryPeriod || undefined,
      commissionRatePercent: payload.commissionRatePercent !== undefined ? Number(payload.commissionRatePercent) : undefined,
      notes: payload.notes || null,
    };
    const addendum = await createContractAddendum(id, input, session);
    return NextResponse.json(addendum, { status: 201 });
  } catch (error: any) {
    console.error("Failed to create contract addendum:", error);
    return NextResponse.json(
      { message: error?.message || "تعذّر إضافة الملحق." },
      { status: 400 }
    );
  }
}
