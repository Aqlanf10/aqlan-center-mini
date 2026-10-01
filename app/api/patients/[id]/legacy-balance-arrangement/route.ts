import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { recordAudit, CLINIC_TIME_ZONE } from "@/lib/db";
import {
  cancelLegacyBalanceArrangement,
  createLegacyBalanceArrangement,
  listLegacyBalanceArrangements,
} from "@/lib/legacy-balance-arrangements-db";
import { isLegacyArrangementCadence } from "@/lib/legacy-balance-arrangements";
import { isCurrency, parseAmount } from "@/lib/money";
import { canAccessPatient } from "@/lib/patient-access";
import { canViewMoney } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function idOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function canManage(role: string): boolean {
  return role === "admin" || role === "reception";
}

async function mayView(session: Awaited<ReturnType<typeof requireSession>>, patientId: number): Promise<boolean> {
  if (!session) return false;
  if (session.role === "doctor") {
    return canAccessPatient(session, patientId, "canViewPatientPayments").catch(() => false);
  }
  return canViewMoney(session.role);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const patientId = idOf((await params).id);
  if (!patientId) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await mayView(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على ترتيب رصيد هذا المريض." }, { status: 403 });
  }
  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    return NextResponse.json({
      arrangements: await listLegacyBalanceArrangements(patientId, today),
      canManage: canManage(session.role),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ترتيب الرصيد السابق." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canManage(session.role)) {
    return NextResponse.json({ message: "ترتيب أقساط الرصيد السابق للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = idOf((await params).id);
  if (!patientId) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (!isCurrency(source.currency)) {
    return NextResponse.json({ message: "اختر عملة الرصيد السابق." }, { status: 400 });
  }
  if (!isLegacyArrangementCadence(source.cadence)) {
    return NextResponse.json({ message: "اختر طريقة القسط: مع كل زيارة أو شهري." }, { status: 400 });
  }
  const installmentMinor = parseAmount(String(source.installmentAmount ?? ""), source.currency);
  if (installmentMinor === null || installmentMinor <= 0) {
    return NextResponse.json({ message: "اكتب قيمة القسط المقترح." }, { status: 400 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  let firstDueDate: string | null = null;
  if (source.cadence === "monthly") {
    firstDueDate = typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate)
      ? source.firstDueDate
      : today;
    if (firstDueDate < today) {
      return NextResponse.json({ message: "بداية الترتيب الشهري لا تكون قبل اليوم؛ هذا ترتيب تحصيل جديد لا إعادة كتابة للتاريخ." }, { status: 400 });
    }
  }
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300)
    : null;

  try {
    const result = await createLegacyBalanceArrangement({
      patientId,
      currency: source.currency,
      cadence: source.cadence,
      installmentMinor,
      firstDueDate,
      note,
      createdBy: session.username,
      today,
    });
    if (!result.ok) {
      const messages = {
        patient_not_found: "المريض غير موجود.",
        no_opening_balance: "لا يوجد رصيد سابق بهذه العملة.",
        opening_settled: "الرصيد السابق بهذه العملة مسدّد بالفعل.",
        already_active: "يوجد ترتيب تحصيل نشط لهذه العملة. ألغِه أولًا إذا أردت تغييره.",
        installment_exceeds_remaining: "قيمة القسط أكبر من المتبقي من الرصيد السابق.",
      } as const;
      const status = result.reason === "patient_not_found" || result.reason === "no_opening_balance" ? 404 : 409;
      return NextResponse.json({ message: messages[result.reason] }, { status });
    }
    await recordAudit({
      action: "legacy_balance_arrangement.create",
      entity: "patient",
      entityId: patientId,
      details: {
        العملة: result.arrangement.currency,
        الرصيد_عند_الترتيب: result.arrangement.startingDueMinor,
        القسط: result.arrangement.installmentMinor,
        النمط: result.arrangement.cadence,
        أول_استحقاق: result.arrangement.firstDueDate,
        ملاحظة: result.arrangement.note,
      },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json(result.arrangement, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء ترتيب تحصيل الرصيد السابق." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canManage(session.role)) {
    return NextResponse.json({ message: "تعديل ترتيب الرصيد السابق للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = idOf((await params).id);
  if (!patientId) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const arrangementId = Number(source.arrangementId);
  if (!Number.isInteger(arrangementId) || arrangementId <= 0) {
    return NextResponse.json({ message: "ترتيب الرصيد غير صالح." }, { status: 400 });
  }
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
  if (reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب إلغاء أو تغيير ترتيب القسط." }, { status: 400 });
  }
  try {
    const result = await cancelLegacyBalanceArrangement({
      patientId, arrangementId, actor: session.username, reason,
    });
    if (!result.ok) {
      return NextResponse.json({
        message: result.reason === "already_cancelled" ? "هذا الترتيب ملغى مسبقًا." : "ترتيب الرصيد غير موجود.",
      }, { status: 404 });
    }
    await recordAudit({
      action: "legacy_balance_arrangement.cancel",
      entity: "patient",
      entityId: patientId,
      details: {
        الترتيب: arrangementId,
        العملة: result.arrangement.currency,
        القسط: result.arrangement.installmentMinor,
        السبب: reason,
      },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر إلغاء ترتيب الرصيد السابق." }, { status: 500 });
  }
}
