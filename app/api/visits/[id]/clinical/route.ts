import { NextResponse } from "next/server";
import {
  addVisitAddendum, doctorOwnsPatient, getClinicalVisit, getSettings, recordAudit,
  saveClinicalNotes, setVisitProcedures, signClinicalVisit,
} from "@/lib/db";
import { isCurrency } from "@/lib/money";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const clinicalOnly = () =>
  NextResponse.json({ message: "التوثيق السريري للطبيب والمدير." }, { status: 403 });

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const visitId = await idFrom(context);
  if (!visitId) return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });

  try {
    const visit = await getClinicalVisit(visitId);
    if (!visit) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });

    // عزل الطبيب (§٣٩): زيارة مريضٍ ليس من مرضاه لا تُفتح — الفحص في الخادم.
    // والزيارة الحرّة غير المربوطة بمريضٍ تبقى مفتوحة: من يعالجها هو من يربطها.
    if (
      session.role === "doctor" && typeof session.partyId === "number" && session.partyId &&
      visit.patientId !== null
    ) {
      const owns = await doctorOwnsPatient(session.partyId, visit.patientId).catch(() => false);
      if (!owns) {
        return NextResponse.json({ message: "هذه زيارة مريضٍ ليس من مرضاك." }, { status: 403 });
      }
    }

    return NextResponse.json(visit);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الزيارة." }, { status: 500 });
  }
}

/**
 * حفظ التوثيق والإجراءات، أو توقيع الزيارة، أو إضافة ملحق.
 *
 * والتوقيع هو **الحلقة**: يولّد الفاتورة ويحدّث المخطط في معاملة واحدة. ولذلك يُطلب
 * بفعلٍ صريح (`action: "sign"`) لا كأثر جانبي لحفظ — فعملٌ يترتّب عليه مالٌ لا يقع
 * بالخطأ.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "doctor" && session.role !== "admin") return clinicalOnly();

  const visitId = await idFrom(context);
  if (!visitId) return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const action = String(source.action ?? "save");
  const text = (value: unknown, max = 2000) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

  try {
    if (action === "addendum") {
      const note = text(source.text, 1000);
      if (!note) return NextResponse.json({ message: "اكتب نصّ الملحق." }, { status: 400 });
      const added = await addVisitAddendum({ visitId, text: note, author: session.username });
      if (!added) {
        return NextResponse.json(
          { message: "الملحق يُضاف على زيارة موقَّعة فقط." }, { status: 409 },
        );
      }
      await recordAudit({
        action: "visit.addendum", entity: "visit", entityId: visitId,
        details: { النص: note }, actor: session.username, actorRole: session.role,
      });
      return NextResponse.json(await getClinicalVisit(visitId));
    }

    if (action === "sign") {
      const settings = await getSettings();
      const base = settings["finance.base_currency"];
      if (!isCurrency(base)) {
        return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
      }
      const result = await signClinicalVisit({ visitId, baseCurrency: base, signedBy: session.username });
      const messages: Record<string, string> = {
        not_found: "الزيارة غير موجودة.",
        already_signed: "الزيارة موقَّعة سلفًا. التصحيح يكون بملحق.",
        empty: "سجّل إجراءً أو تشخيصًا قبل توقيع الزيارة.",
        no_patient: "اربط الزيارة بملف مريض قبل التوقيع — الفاتورة تدخل كشف حسابه.",
      };
      if (result.reason) {
        return NextResponse.json({ message: messages[result.reason] }, { status: 409 });
      }
      await recordAudit({
        action: "visit.sign", entity: "visit", entityId: visitId,
        entityLabel: result.visit?.patientName,
        details: {
          الإجراءات: result.visit?.procedures.length ?? 0,
          الإجمالي: result.duesMinor,
          الفاتورة: result.invoiceId,
          تحديثات_المخطط: result.chartUpdates,
          بنود_اكتملت: result.planItemsDone,
          جلسات_منجزة: result.sessionsCompleted,
          طلبات_معمل_تلقائية: result.labOrdersCreated,
          حركات_مستهلكات: result.materialsDeducted,
          الجلسة_القادمة: result.nextPlannedVisit?.title ?? null,
        },
        actor: session.username, actorRole: session.role,
      });
      /*
       * الاستجابة تحمل نتيجة الرحلة كاملة: الاستحقاق الذي تولّد وفق قواعد الفوترة،
       * والجلسات المنجَزة، والزيارة المخطَّطة المقترحة التالية — فتفتح الشبّاك
       * (Checkout) والاستقبال يعرفان ماذا يحصّلان وماذا يُحجَز من غير بحث.
       */
      return NextResponse.json({
        ...result.visit,
        invoiceId: result.invoiceId,
        duesMinor: result.duesMinor,
        sessionsCompleted: result.sessionsCompleted,
        nextPlannedVisit: result.nextPlannedVisit,
        labOrdersCreated: result.labOrdersCreated,
        materialsDeducted: result.materialsDeducted,
      });
    }

    // حفظ التوثيق والإجراءات معًا: الطبيب يكتب ويختار في شاشة واحدة.
    const saved = await saveClinicalNotes({
      visitId,
      chiefComplaint: text(source.chiefComplaint, 500),
      examination: text(source.examination),
      diagnosis: text(source.diagnosis),
      treatmentDone: text(source.treatmentDone),
      nextPlan: text(source.nextPlan, 500),
      doctorId: Number(source.doctorId) || null,
    });
    if (!saved) {
      return NextResponse.json(
        { message: "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا." }, { status: 409 },
      );
    }

    if (Array.isArray(source.procedures)) {
      const procedures = source.procedures
        .map((row) => row as Record<string, unknown>)
        .filter((row) => Number(row.serviceId) > 0)
        .map((row) => ({
          serviceId: Number(row.serviceId),
          toothCode: Number(row.toothCode) || null,
          surfaces: typeof row.surfaces === "string" ? row.surfaces : null,
          quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
          unitPriceMinor: Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)),
          doctorId: Number(row.doctorId) || null,
          note: text(row.note, 300),
          // الربط ببند الخطة: السعر يأتي عندها من الخطة وفق قاعدة الفوترة — لا من الطلب.
          planItemId: Number(row.planItemId) > 0 ? Number(row.planItemId) : null,
        }));
      const ok = await setVisitProcedures({ visitId, procedures });
      if (!ok) {
        return NextResponse.json({ message: "الزيارة موقَّعة — لا تُعدَّل إجراءاتها." }, { status: 409 });
      }
    }

    return NextResponse.json(await getClinicalVisit(visitId));
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الزيارة." }, { status: 500 });
  }
}
