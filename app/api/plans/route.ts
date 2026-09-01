import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  createPlan,
  createPlanV2,
  doctorOwnsPatient,
  findUserByUsername,
  getSettings,
  listActivePlans,
  listPatientPlans,
  recordAudit,
} from "@/lib/db";
import { splitInstallments } from "@/lib/plans";
import { normalizeBillingRule, normalizeSessionCount, type BillingRule } from "@/lib/workflow";
import { isCurrency, parseAmount } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));

  /* صلاحيات الوكيل المساعد: الطبيب بلا صلاحية الخطط ممنوع، ومن يملكها لا يقرأ
     إلا خطط مرضاه (عزل الخادم) — وعموم الخطط تبقى للإدارة والاستقبال. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canViewPlans === false) {
      return NextResponse.json({ message: "غير مصرّح لك بعرض خطط العلاج." }, { status: 403 });
    }
    if (Number.isInteger(patientId) && patientId > 0) {
      const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
      if (doctorPartyId) {
        const owns = await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false);
        if (!owns) {
          return NextResponse.json(
            { message: "غير مصرّح لك بالاطلاع على خطط هذا المريض." },
            { status: 403 },
          );
        }
      } else {
        return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
      }
    } else {
      return NextResponse.json({ message: "حدّد المريض أولًا — القائمة الشاملة للإدارة والاستقبال." }, { status: 403 });
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const plans = Number.isInteger(patientId) && patientId > 0
      ? await listPatientPlans(patientId, today)
      : await listActivePlans(today);
    const settings = await getSettings();
    const base = settings["finance.base_currency"];
    return NextResponse.json({ plans, today, baseCurrency: isCurrency(base) ? base : "YER" });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الخطط." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  /* صلاحيات الوكيل المساعد: الطبيب الذي فتح له المدير تحرير الخطط ينشئها
     لمرضاه فقط؛ وما عدا ذلك يبقى باب الخطة للإدارة والاستقبال كما في V2. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canEditPlans === false) {
      return NextResponse.json({ message: "غير مصرّح لك بإنشاء أو تعديل خطط العلاج." }, { status: 403 });
    }
    const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
    if (!doctorPartyId || !Number.isInteger(patientId) || !(await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false))) {
      return NextResponse.json(
        { message: "غير مصرّح لك بإنشاء خطة لهذا المريض." },
        { status: 403 },
      );
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title || title.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الخطة — مثل: تقويم ثابت فكّين." }, { status: 400 });
  }

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const startDate = typeof source.startDate === "string" && DATE_PATTERN.test(source.startDate)
    ? source.startDate : today;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  /*
   * ── الرحلة V2: نموذجٌ واحد زرٌّ واحد ──
   *
   * `mode: "v2"` يبني الخطة كاملة في معاملة واحدة: بنودها المسعَّرة بقواعد
   * الفوترة وجلساتها، وزياراتها المخطَّطة، وطريقة دفعها (حسب المنفَّذ أو أقساط
   * أو جدول مخصص). والمساران القديمان (clinical/financial) يبقيان كما هما —
   * واجهات قديمة واختبارات تعمل بها، وتُزال حين تثبت الواجهة الجديدة (المواصفة §٤٢).
   */
  if (source.mode === "v2") {
    const rawItems = Array.isArray(source.items) ? source.items : [];
    const items = rawItems
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        serviceId: Number(row.serviceId) > 0 ? Number(row.serviceId) : null,
        serviceName: typeof row.serviceName === "string" ? row.serviceName.trim() : "",
        category: typeof row.category === "string" ? row.category : null,
        toothCode: Number(row.toothCode) > 0 ? Number(row.toothCode) : null,
        surfaces: typeof row.surfaces === "string" && row.surfaces.trim() ? row.surfaces : null,
        quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
        unitPriceMinor: Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)),
        billingRule: normalizeBillingRule(row.billingRule) as BillingRule,
        sessionCount: normalizeSessionCount(row.sessionCount),
        note: typeof row.note === "string" && row.note.trim()
          ? row.note.trim().slice(0, 300) : null,
      }))
      .filter((item) => item.serviceName.length > 0);

    const billingModeRaw = String(source.billingMode ?? "per_procedure");
    const billingMode =
      billingModeRaw === "installments" || billingModeRaw === "custom_schedule"
        ? billingModeRaw
        : items.length > 0 ? "per_procedure" : "installments";

    // الأقساط: جدولٌ جاهز (count/everyDays) أو جدولٌ مخصص (سطور بتواريخها).
    const installments: { dueDate: string; amountMinor: number }[] = [];
    if (billingMode === "installments" || Array.isArray(source.installments)) {
      if (Array.isArray(source.installments)) {
        for (const raw of source.installments) {
          const row = raw as Record<string, unknown>;
          const dueDate = typeof row.dueDate === "string" && DATE_PATTERN.test(row.dueDate)
            ? row.dueDate : "";
          const amountMinor = Math.round(Number(row.amountMinor) || 0);
          if (dueDate && amountMinor > 0) installments.push({ dueDate, amountMinor });
        }
      }
      if (installments.length === 0) {
        const totalMinor = parseAmount(String(source.total ?? ""), base) ?? 0;
        const count = Math.round(Number(source.count ?? 0));
        const everyDays = Math.round(Number(source.everyDays ?? 30));
        if (totalMinor > 0 && count >= 1 && count <= 60 && everyDays >= 1 && everyDays <= 365) {
          for (const part of splitInstallments(totalMinor, count, startDate, everyDays)) {
            installments.push({ dueDate: part.dueDate, amountMinor: part.amountMinor });
          }
        }
      }
    }

    if (items.length === 0 && installments.length === 0) {
      return NextResponse.json(
        { message: "أضف بنود الخطة أو المبلغ المتفق عليه مع جدول أقساطه." }, { status: 400 },
      );
    }

    try {
      const specialty = typeof source.specialty === "string" && source.specialty.trim()
        ? source.specialty.trim().slice(0, 80) : null;
      const primaryDoctorId = Number(source.primaryDoctorId) > 0
        ? Number(source.primaryDoctorId) : null;

      const created = await createPlanV2({
        patientId, title, specialty, primaryDoctorId,
        billingMode, baseCurrency: base, startDate, note,
        items, installments, createdBy: session.username,
      });
      if (!created.ok) {
        return NextResponse.json({ message: created.message }, { status: 400 });
      }
      await recordAudit({
        action: "plan.create_v2", entity: "treatment_plan", entityId: created.planId,
        entityLabel: title,
        details: {
          البنود: items.length,
          الجلسات: items.reduce((sum, item) => sum + item.sessionCount, 0),
          طريقة_الدفع: billingMode,
          الأقساط: installments.length,
        },
        actor: session.username, actorRole: session.role,
      });
      return NextResponse.json({ id: created.planId }, { status: 201 });
    } catch {
      return NextResponse.json({ message: "تعذّر إنشاء الخطة. تأكد من المريض." }, { status: 500 });
    }
  }

  /*
   * المساران القديمان — طريقان لخطةٍ واحدة، لا نوعان من الخطط.
   *
   * «مالية»: مبلغٌ متفَقٌ عليه يُقسَّط، وهو ما يكفي مريض التقويم الذي اتفق على رقم.
   * «سريرية»: تُنشأ فارغة ثم تُبنى ببنودها، فيُشتقّ إجماليّها منها. والكائن واحد في
   * الحالتين — لأن مريضًا واحدًا قد يبدأ بحشواتٍ مفصَّلة ثم يقسّط ما اتفق عليه.
   */
  const clinical = source.mode === "clinical";

  const totalMinor = clinical ? 0 : parseAmount(String(source.total ?? ""), base);
  if (totalMinor === null || (!clinical && totalMinor <= 0)) {
    return NextResponse.json({ message: "اكتب المبلغ الإجمالي المتفق عليه." }, { status: 400 });
  }

  const count = Math.round(Number(source.count ?? 1));
  if (!clinical && (!Number.isFinite(count) || count < 1 || count > 60)) {
    return NextResponse.json({ message: "عدد الأقساط بين 1 و60." }, { status: 400 });
  }
  const everyDays = Math.round(Number(source.everyDays ?? 30));
  if (!clinical && (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365)) {
    return NextResponse.json({ message: "المدة بين الأقساط بين 1 و365 يومًا." }, { status: 400 });
  }

  try {
    const id = await createPlan({
      patientId, title, totalMinor, baseCurrency: base, startDate, note,
      createdBy: session.username,
      installments: clinical ? [] : splitInstallments(totalMinor, count, startDate, everyDays),
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء الخطة. تأكد من المريض." }, { status: 500 });
  }
}
