import { NextResponse } from "next/server";
import {
  listPatientPlans, patientLedger,
} from "@/lib/db";
import { planLedgerSummary } from "@/lib/plans";
import {
  CLINIC_BASE_CURRENCY, patientBalancesByCurrency, toCurrencyPaymentLikes,
} from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/** حساب المريض: فواتيره ودفعاته ورصيده — الرقم الذي يُسأل عنه على الباب. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }

  /* صلاحيات الوكيل المساعد + «المالية المخفية»: مدفوعات مريضٍ أمرٌ مالي يُدار
     بصراحة — الطبيب يراها فقط إن منحه المدير ذلك، ومعها عزل مرضاه. V2 أبقى
     الباب مفتوحًا للإدارة والاستقبال كما هو. */
  if (session.role === "doctor") {
    const allowed = await canAccessPatient(session, id, "canViewPatientPayments");
    if (!allowed) {
      return NextResponse.json(
        { message: "غير مصرّح لك بالاطلاع على حساب هذا المريض." },
        { status: 403 },
      );
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const [{ invoices, payments, opening }, plans] = await Promise.all([
      patientLedger(id),
      listPatientPlans(id, today),
    ]);
    /* (TD-05) أرصدة بعملاتها المستقلة: كل عملة اتفاقٍ بدلوها، والدفعات تسوّي
       دلو فاتورتها إن رُبطت به، ودلو خطتها إن قُيّدت عليها (المقدَّمة قبل
       الفوترة)، وإلا دلو الأساس — لا رقمٌ واحد يمزج العملات. */
    const balances = patientBalancesByCurrency(
      invoices.map((invoice) => ({
        totalMinor: invoice.totalMinor,
        discountMinor: invoice.discountMinor,
        status: invoice.status,
        baseCurrency: invoice.baseCurrency,
      })),
      toCurrencyPaymentLikes(
        id,
        payments.map((payment) => ({
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          exchangeRate: payment.exchangeRate,
          baseAmountMinor: payment.baseAmountMinor,
          kind: payment.kind,
          invoiceId: payment.invoiceId,
          planId: payment.planId,
        })),
        // (المراجعة النهائية للمال ٢) المرجع يحمل مالكه — ومستندات هذا الحساب من
        // المريض نفسه فالملكية تُطابَق حكمًا وتُمنح صريحةً للمسار القانوني.
        new Map(invoices.map((invoice) => [invoice.id, { patientId: id, currency: invoice.baseCurrency }])),
        new Map(plans.map((plan) => [plan.id, { patientId: id, currency: plan.baseCurrency }])),
      ),
      opening?.amountMinor ?? 0,
    );
    // النظرة المفردة القديمة (دلو الأساس) بقيت للتوافق مع من يقرأ حقلًا واحدًا.
    const balance = balances[CLINIC_BASE_CURRENCY];
    return NextResponse.json({
      invoices, payments, opening, balance, balances, baseCurrency: CLINIC_BASE_CURRENCY,
      // قصص الخطط: الخطة اتفاق لا دَين، لكن الحساب الذي يصمت عن اتفاقٍ قائم
      // يبدو ملفًّا مفكّكًا — وهذا هو الجسر.
      plans: plans.map(planLedgerSummary),
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل حساب المريض." }, { status: 500 });
  }
}
