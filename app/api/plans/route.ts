import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  createPlan,
  getSettings,
  listActivePlans,
  listPatientPlans,
} from "@/lib/db";
import { splitInstallments } from "@/lib/plans";
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
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));

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
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
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

  /*
   * طريقان لخطةٍ واحدة — لا نوعان من الخطط.
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

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const startDate = typeof source.startDate === "string" && DATE_PATTERN.test(source.startDate)
    ? source.startDate : today;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

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
