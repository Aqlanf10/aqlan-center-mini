/**
 * فحص القدرة السريرية المركزي (Central Clinical Capability Check)
 *
 * الدستور الحاكم: **الصلاحية السريرية هويةٌ لا زرُّ تفعيلٍ.**
 * فتح نافذة المساعد الذكي (canUseAiChat) يمنح *المساعد الإداري* — دعم
 * القرار السريري الحساس (اختيار دواء، اقتراح جرعة، توصية علاج، تقرير طبي
 * يعتمد قرارًا طبيًا) ليس مضمنًا فيه ولا يُشتق منه.
 *
 * من يملك «هوية سريرية»؟
 * - **طبيب**: حسابه مرتبط بجهة طبيب صالحة (doctorPartyId > 0) — هوية مُصدر
 *   الوصفات والتقارير باسمه، ومن غير المقبول أن يقترح دواءً باسمٍ لا يملكه.
 * - **مدير**: **لا يُعدّ طبيبًا لمجرد أنه مدير.** يُمنح القدرة السريرية فقط إذا
 *   رُبط حسابه صراحةً بجهة طبيب (clinical identity) من شاشة المستخدمين.
 * - **استقبال**: أبدًا — حتى لو فعّل المدير له canUseAiChat؛ فهذا يفتح المساعد
 *   الإداري (مواعيد، مرضى ضمن صلاحيته، رسائل، أدلة تشغيلية، مالية مسموحة)
 *   ولا يفتح باب القرار السريري.
 *
 * الفحص مركزيٌّ واحد تستهلكه: سياسة أدوات AI (P0)، إصدار الوصفة، وإبطالها —
 * فلا تتوزع الشروط فتتفرق المعايير بين مسارٍ ومسار.
 */

import type { Role } from "./roles";

export interface ClinicalCapabilityInput {
  role?: string | null;
  userRole?: string | null;
  /** جهة الطبيب المرتبطة بالحساب — تُقرأ من الخادم لا من العميل. */
  doctorPartyId?: number | null;
}

export interface ClinicalCapability {
  ok: boolean;
  /** جهة الطبيب الصالحة عندما تثبت القدرة؛ وإلا null. */
  partyId: number | null;
  reason: string;
}

function validPartyId(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

/**
 * الفحص المركزي الواحد: هل يملك هذا الحساب هويةً سريريةً صالحة؟
 * الدور «reception» مرفوض جملةً؛ و«doctor» و«admin» كلاهما يحتاج ربطًا صريحًا
 * بجهة طبيب — فالقدرة السريرية تُمنح بالهوية لا بالوظيفة الإدارية.
 */
export function clinicalCapabilityOf(input: ClinicalCapabilityInput): ClinicalCapability {
  const role = (input.role ?? input.userRole) as Role | string | null | undefined;
  const partyId = validPartyId(input.doctorPartyId);

  if (role === "reception") {
    return {
      ok: false,
      partyId: null,
      reason: "حساب الاستقبال إداريٌّ تشغيلي: تفعيل المساعد الذكي له يمنح المساعد الإداري (المواعيد والمرضى ضمن صلاحيته والرسائل والأدلة والمالية المسموحة) — لا دعم القرار السريري.",
    };
  }

  if (role === "doctor") {
    if (!partyId) {
      return {
        ok: false,
        partyId: null,
        reason: "حساب الطبيب غير مرتبط بجهة طبيب — لا قدرة سريرية بلا هوية مُصدر.",
      };
    }
    return { ok: true, partyId, reason: "" };
  }

  if (role === "admin") {
    if (!partyId) {
      return {
        ok: false,
        partyId: null,
        reason: "المدير الإداري بلا هوية سريرية (حساب غير مرتبط بجهة طبيب) لا يُعدّ طبيبًا تلقائيًا — اربط الحساب بجهة طبيب صريحة إن أريدت الوظائف السريرية.",
      };
    }
    return { ok: true, partyId, reason: "" };
  }

  return { ok: false, partyId: null, reason: "دور غير معروف — الرفض الافتراضي." };
}

/** هل جهة الطبيب هذه هي مُصدر الوصفة؟ (لوصفة قديمة بلا جهة: مطابقة اسم المُنشئ.) */
export function isIssuingClinician(
  prescription: { doctorPartyId?: number | null; createdBy?: string | null },
  clinician: { partyId: number | null; username: string },
): boolean {
  const issuerPartyId = validPartyId(prescription.doctorPartyId);
  if (issuerPartyId != null) {
    return clinician.partyId != null && issuerPartyId === clinician.partyId;
  }
  /* وصفة قديمة قبل ربط الجهات: المُصدر اسمٌ محفوظ — مطابقته كافية لمالكها. */
  return Boolean(prescription.createdBy) && prescription.createdBy === clinician.username;
}
