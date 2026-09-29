import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, adjustPartyOpeningPayable, createPartyOpeningAdvance, createPartyOpeningPayable,
  getSettings, isPeriodLocked, listParties, listPartyOpenings, voidPartyOpeningAdvance,
} from "@/lib/db";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount } from "@/lib/money";
import { rateFromSettings } from "@/lib/settings";
import { clinicDateString } from "@/lib/schedule";
import { canViewFinancialReports } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (FIA-1) ديون المعامل والموردين السابقة لبدء النظام، وأرصدتنا المقدَّمة عندهم.
 *
 * الإدخال والتصحيح والإلغاء **للمدير وحده** وبسببٍ مكتوب: سطرٌ هنا يغيّر ما على المركز لجهةٍ
 * بلا فاتورة ولا سند. والقراءة لمن يرى التقارير المالية. لا حذف أبدًا — التصحيح فرقٌ مسبَّب
 * (الدَّين) أو إلغاءٌ مسبَّب (الرصيد المقدَّم)، والسجل كله باقٍ.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const adminOnly = () =>
  NextResponse.json({ message: "الأرصدة السابقة للمعامل والموردين للمدير وحده." }, { status: 403 });

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewFinancialReports(session.role)) {
    return NextResponse.json({ message: "الأرصدة السابقة لمن يرى التقارير المالية." }, { status: 403 });
  }
  try {
    const [openings, labs, suppliers] = await Promise.all([
      listPartyOpenings(), listParties("lab"), listParties("supplier"),
    ]);
    const parties = [...labs, ...suppliers]
      .map((party) => ({ id: party.id, name: party.name, kind: party.kind }));
    return NextResponse.json({ ...openings, parties, canEdit: session.role === "admin" });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الأرصدة السابقة للجهات." }, { status: 500 });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    return ((await readJsonBody(request, JSON_BODY_LIMIT_BYTES)) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "admin") return adminOnly();
  const source = await readBody(request);
  if (source instanceof NextResponse) return source;

  const kind = source.kind === "advance" ? "advance" : source.kind === "payable" ? "payable" : null;
  if (!kind) return NextResponse.json({ message: "حدّد النوع: دَينٌ علينا أم رصيدٌ مقدَّم لنا." }, { status: 400 });
  const partyId = Number(source.partyId);
  if (!Number.isInteger(partyId) || partyId <= 0) {
    return NextResponse.json({ message: "اختر المختبر أو المورّد." }, { status: 400 });
  }
  const currency = source.currency === undefined || source.currency === "" ? CLINIC_BASE_CURRENCY : source.currency;
  if (!isCurrency(currency)) return NextResponse.json({ message: "العملة يجب أن تكون YER أو SAR أو USD." }, { status: 400 });
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor <= 0) {
    return NextResponse.json({ message: "اكتب المبلغ السابق بعملته — أكبر من صفر." }, { status: 400 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOfDate = typeof source.asOfDate === "string" && DATE_PATTERN.test(source.asOfDate) ? source.asOfDate : null;
  if (!asOfDate) return NextResponse.json({ message: "اكتب تاريخ الرصيد (حتى تاريخ)." }, { status: 400 });
  if (asOfDate > today) return NextResponse.json({ message: "تاريخ الرصيد السابق لا يكون في المستقبل." }, { status: 400 });
  const dueDate = typeof source.dueDate === "string" && DATE_PATTERN.test(source.dueDate) ? source.dueDate : null;
  const reason = text(source.reason, 300);
  if (!reason || reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب الإدخال — مثل: كشف حساب ورقي قبل بدء النظام." }, { status: 400 });
  }
  if (await isPeriodLocked(asOfDate)) {
    return NextResponse.json({ message: "الفترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال." }, { status: 409 });
  }
  const exchangeRate = rateFromSettings(await getSettings(), currency, CLINIC_BASE_CURRENCY);
  if (exchangeRate === null) {
    return NextResponse.json({ message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات أولًا." }, { status: 409 });
  }

  try {
    const common = {
      partyId, currency, amountMinor, exchangeRate, asOfDate,
      reference: text(source.reference, 120), note: text(source.note, 300), reason,
      actor: session.username, actorRole: session.role,
    };
    const result = kind === "payable"
      ? await createPartyOpeningPayable({ ...common, dueDate })
      : await createPartyOpeningAdvance(common);
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
    return NextResponse.json(result.value, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الرصيد السابق." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "admin") return adminOnly();
  const source = await readBody(request);
  if (source instanceof NextResponse) return source;
  const reason = text(source.reason, 300);
  if (!reason || reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب التصحيح — يبقى في السجل مع القيمتين." }, { status: 400 });
  }

  try {
    if (source.action === "adjust") {
      const payableId = Number(source.payableId);
      if (!Number.isInteger(payableId) || payableId <= 0) {
        return NextResponse.json({ message: "الرصيد الافتتاحي غير محدد." }, { status: 400 });
      }
      const currency = isCurrency(source.currency) ? source.currency : CLINIC_BASE_CURRENCY;
      const newAmountMinor = parseAmount(String(source.amount ?? ""), currency);
      if (newAmountMinor === null || newAmountMinor < 0) {
        return NextResponse.json({ message: "اكتب القيمة الصحيحة للرصيد." }, { status: 400 });
      }
      const result = await adjustPartyOpeningPayable({
        payableId, newAmountMinor, reason, actor: session.username, actorRole: session.role,
      });
      if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
      return NextResponse.json(result.value);
    }
    if (source.action === "void_advance") {
      const id = Number(source.id);
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ message: "الرصيد المقدَّم غير محدد." }, { status: 400 });
      }
      const result = await voidPartyOpeningAdvance({ id, reason, actor: session.username, actorRole: session.role });
      if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
      return NextResponse.json(result.value);
    }
    return NextResponse.json({ message: "إجراءٌ غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التصحيح." }, { status: 500 });
  }
}
