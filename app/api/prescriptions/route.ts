import { NextResponse } from "next/server";
import { getClinicalVisit, getPatient, findUserByUsername, savePrescription } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { checkPrescriptionDraft } from "@/lib/prescription";
import { evaluatePrescriptionSafety } from "@/lib/medication-safety";
import { clinicalCapabilityOf } from "@/lib/clinical-identity";
import {
  buildSafetyAcknowledgementToken,
  verifySafetyAcknowledgementToken,
} from "@/lib/prescription-safety-ack";

export const dynamic = "force-dynamic";

/**
 * إصدار وصفة كوثيقة محفوظة. (من مستودع الوكيل الآخر.)
 *
 * الوصفة وثيقةٌ لا شاشة: يحملها المريض إلى صيدليٍّ يصرف بها دواءً، ويرجع إليها
 * الطبيب بعد شهرٍ ليعرف بماذا عالج. فما يُطبع منها يجب أن يكون محفوظًا كما طُبع،
 * منسوبًا إلى من أصدره، وبتاريخه.
 *
 * حرس الباب (P0.8):
 * - **هوية سريرية لا إدارية**: الطبيب بجلسته، والمدير لا يُعد «طبيبًا» لمجرد
 *   أنه مدير — لا يصدر وصفة إلا إن كان له ارتباطٌ سريري صريح (حساب مستخدم
 *   مرتبط بجهة طبيب). هوية المُصدر تُقرأ من الخادم لا من العميل.
 * - **الزيارة تخص المريض نفسه**: visitId إن أُرسل يُحلّ ويُطابق patientId —
 *   فلا تُربط وصفة مريضٍ بزيارة مريضٍ آخر.
 * - **فحص السلامة الدوائي على الخادم**: القيود الحرجية (حساسية بنسلين مع
 *   بنسلينات مثلًا) تمنع الحفظ — لا يكفي أن تكون الواجهة أظهرت التحذير.
 * - **التحذيرات غير الحرجة تُقرّ لا تُمرّر** (مراجعة الجولة الثانية): الخادم
 *   يردّ عرضًا (requiresAcknowledgement) بلا حفظ، مع رمز إقرارٍ محسوب فوق
 *   المحتوى الكانوني الدقيق للوصفة؛ ولا تُحفظ إلا بإعادة الإرسال بالرمز نفسه
 *   — فلو غيّر الطبيب دواءً بعد الإقرار بطل الرمز وأُعيد العرض. الخادم هو
 *   المرجع، لا فحص الواجهة عندها.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  /* التفويض السريري: طبيب، أو مدير له هوية سريرية صريحة (جهة طبيب مرتبطة). */
  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user || !user.isActive) {
    return NextResponse.json({ message: "الحساب غير نشط." }, { status: 403 });
  }
  /* الفحص المركزي الموحّد للقدرة السريرية (lib/clinical-identity.ts) —
     نفس الفحص الذي تحرس به أدوات AI السريرية وإبطال الوصفات. */
  const capability = clinicalCapabilityOf({ role: session.role, doctorPartyId: user.partyId });
  if (!capability.ok) {
    return NextResponse.json({ message: capability.reason }, { status: 403 });
  }
  const doctorPartyId = capability.partyId;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const patientId = Number(body.patientId);
  const rawVisit = Number(body.visitId);
  const visitId = Number.isInteger(rawVisit) && rawVisit > 0 ? rawVisit : null;
  const acknowledgedSafetyToken =
    typeof body.acknowledgedSafetyToken === "string" && body.acknowledgedSafetyToken.length > 0
      ? body.acknowledgedSafetyToken
      : null;
  const draft = checkPrescriptionDraft({
    patientId,
    visitId,
    diagnosis: body.diagnosis,
    notes: body.notes,
    instructionsLang: body.instructionsLang,
    items: body.items,
  });
  if (!draft.ok) {
    return NextResponse.json({ message: draft.message }, { status: 400 });
  }

  if (!(await canAccessPatient(session, draft.value.patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بإصدار وصفة لهذا المريض." }, { status: 403 });
  }

  /* الزيارة إن ذُكرت يجب أن تكون زيارة هذا المريض نفسه — لا زيارة مريض آخر. */
  if (draft.value.visitId != null) {
    const visit = await getClinicalVisit(draft.value.visitId).catch(() => null);
    if (!visit) {
      return NextResponse.json({ message: "الزيارة المذكورة غير موجودة." }, { status: 400 });
    }
    if (visit.patientId !== draft.value.patientId) {
      return NextResponse.json(
        { message: "الزيارة المذكورة تخص مريضًا آخر — لا تُربط وصفة مريض بزيارة غيره." },
        { status: 400 },
      );
    }
  }

  /* فحص السلامة الدوائي على الخادم: التنبيهات الطبية المسجلة تُقرأ من الملف
     لا من العميل، والتعارض الحرج يمنع الحفظ حتى يفصل الطبيب (بتحديث الملف
     أو بوصفةٍ بديلة). والتحذيرات غير الحرجة لا تُحفَظ وتُنسى: تُعرض، ويُقرّها
     الطبيب صراحةً، وربطُ الإقرار بالوصفة نفسها برمزٍ خادمي (Blocker B). */
  const patient = await getPatient(draft.value.patientId).catch(() => null);
  if (patient) {
    const alerts = evaluatePrescriptionSafety(
      draft.value.items.map((item) => ({ name: item.name, dose: item.dose })),
      patient.medicalAlert,
    );
    const critical = alerts.filter((alert) => alert.severity === "critical");
    if (critical.length > 0) {
      return NextResponse.json(
        {
          message: "تعارض دوائي حرج مع التنبيهات الطبية المسجلة في ملف المريض — لا تُحفظ الوصفة ولا تُطبَع رسمية.",
          safetyAlerts: critical,
          blockReason: "critical_medication_safety",
        },
        { status: 409 },
      );
    }
    const warnings = alerts.filter((alert) => alert.severity !== "critical");
    if (warnings.length > 0) {
      /* عرض المعاينة أولاً — لا حفظ: يُعاد رمز إقرارٍ خادمي فوق المحتوى الكانوني
       * الدقيق، فلا تُحفظ الوصفة إلا بإعادتها بالرمز نفسه بعد إقرار الطبيب. */
      if (!acknowledgedSafetyToken) {
        return NextResponse.json(
          {
            requiresAcknowledgement: true,
            safetyWarnings: warnings,
            acknowledgementToken: buildSafetyAcknowledgementToken({
              username: session.username,
              draft: draft.value,
            }),
          },
          { status: 200 },
        );
      }
      /* إقرارٌ مُرسل: يُتحقق أنه للمستخدم نفسه وللوصفة نفسها حرفيًا — تغيير دواء
       * أو جرعة بعد الإقرار يبطله ويُعيد العرض. */
      if (
        !verifySafetyAcknowledgementToken(acknowledgedSafetyToken, {
          username: session.username,
          draft: draft.value,
        })
      ) {
        return NextResponse.json(
          {
            message:
              "الوصفة التي تُقرّها ليست الوصفة المعروضة عند التحذيرات (تغيّرت الأدوية/البيانات أو الرمز لا يخصّك) — راجع التحذيرات وأقرّها من جديد.",
            ackRejected: true,
          },
          { status: 409 },
        );
      }
      /* الإقرار صالح ومطابق: تُحفظ الوصفة وتُعاد التحذيرات معها للاطلاع. */
      try {
        const record = await savePrescription(draft.value, session.username, doctorPartyId);
        return NextResponse.json(
          { id: record.id, createdAt: record.createdAt, safetyWarnings: warnings, acknowledged: true },
          { status: 201 },
        );
      } catch {
        return NextResponse.json({ message: "تعذّر حفظ الوصفة." }, { status: 500 });
      }
    }
  }

  try {
    const record = await savePrescription(draft.value, session.username, doctorPartyId);
    return NextResponse.json({ id: record.id, createdAt: record.createdAt }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الوصفة." }, { status: 500 });
  }
}
