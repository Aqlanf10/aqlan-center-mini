import { NextResponse } from "next/server";
import {
  getSettings, listPatientPlans, patientLedger, patientReceiptRemainders, patientReversedInstallmentRecoveries,
} from "@/lib/db";
import { openingBalanceAccess } from "@/lib/opening-access";
import { buildPatientLedgerPayload } from "@/lib/patient-ledger-payload";
import { canViewMoney } from "@/lib/roles";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { listLegacyBalanceArrangements, listLegacyOpeningPositions } from "@/lib/legacy-balance-arrangements-db";
import { readReceiptProvenance } from "@/lib/receipt-provenance-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalPatientLedger } from "@/lib/canonical-patient-account";

export const dynamic = "force-dynamic";

/** حساب المريض: فواتيره ودفعاته ورصيده — الرقم الذي يُسأل عنه على الباب. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 88: finance.patient-ledger.view inside the patient scope; the same body, grants for the controls.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalPatientLedger(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل حساب المريض."); }
  }
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
  } else if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const [
      { invoices, payments, openings }, plans, settings, receiptRemaining,
      legacyBalanceArrangements, legacyOpeningPositions, installmentRecovery,
    ] = await Promise.all([
      patientLedger(id),
      listPatientPlans(id, today),
      getSettings().catch(() => null),
      // (RC-1) المتبقي غير المعكوس من كل سند — للمدير وحده (زرّ «تصحيح السند» له وحده).
      session.role === "admin" ? patientReceiptRemainders(id) : Promise.resolve(undefined),
      listLegacyBalanceArrangements(id, today),
      listLegacyOpeningPositions(id),
      patientReversedInstallmentRecoveries(id),
    ]);
    const money = buildPatientLedgerPayload({ patientId: id, invoices, payments, openings, plans });
    // Display metadata only, after patient authorization and the canonical read.
    const receiptProvenance = await readReceiptProvenance(payments.map((payment) => payment.id));
    return NextResponse.json({
      clinicTimeZone: CLINIC_TIME_ZONE,
      ...money,
      // (DAY1) من يضيف/يعدّل الرصيد السابق — الشاشة تُظهر ما يُسمح به فقط، والخادم يفرضه.
      ...(receiptRemaining ? { receiptRemaining } : {}),
      receiptProvenance,
      openingAccess: openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true"),
      legacyBalanceArrangements,
      legacyOpeningPositions,
      installmentRecovery,
      legacyArrangementAccess: { manage: session.role === "admin" || session.role === "reception" },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل حساب المريض." }, { status: 500 });
  }
}
