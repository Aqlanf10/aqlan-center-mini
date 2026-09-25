/**
 * (P3-8) الإحالة الصادرة — أن يرسل الطبيب مريضه إلى جرّاح أو أخصائي بخطاب.
 *
 * في عيادة تقويم هذا يومي: قلعٌ قبل التقويم (١٤ و٢٤ و٣٤ و٤٤)، جراحة ناب منطمر،
 * تقييم لثة قبل تركيب الجهاز، صورة CBCT. كان الخطاب يُكتب بخط اليد ولا يُحفظ، فلا
 * يُعرف بعد شهر هل قُلعت الأسنان أم ما زال المريض ينتظر — والتقويم متوقف عليه.
 *
 * هنا: الخطاب يُطبع باسم المركز والطبيب، ويبقى في ملف المريض مفتوحًا حتى يُغلق
 * بنتيجته («قُلعت الأربعة في ١٢/١٠») أو يُلغى بسببٍ مكتوب. دوال خالصة: التحقق
 * والتسميات هنا، والقاعدة والشاشة تستهلكانها.
 */

export const REFERRAL_SPECIALTIES = [
  "oral_surgery", "periodontics", "endodontics", "prosthodontics", "implant",
  "restorative", "pediatric", "radiology", "ent", "other",
] as const;
export type ReferralSpecialty = (typeof REFERRAL_SPECIALTIES)[number];

export const REFERRAL_SPECIALTY_LABEL: Record<ReferralSpecialty, string> = {
  oral_surgery: "جراحة الفم والفكين",
  periodontics: "أمراض اللثة",
  endodontics: "علاج الجذور (العصب)",
  prosthodontics: "التركيبات",
  implant: "زراعة الأسنان",
  restorative: "الحشوات والترميم",
  pediatric: "طب أسنان الأطفال",
  radiology: "الأشعة (CBCT / بانوراما)",
  ent: "أنف وأذن وحنجرة",
  other: "أخرى",
};

export const REFERRAL_URGENCIES = ["routine", "soon", "urgent"] as const;
export type ReferralUrgency = (typeof REFERRAL_URGENCIES)[number];

export const REFERRAL_URGENCY_LABEL: Record<ReferralUrgency, string> = {
  routine: "اعتيادية",
  soon: "خلال أسبوع",
  urgent: "عاجلة",
};

export type ReferralStatus = "sent" | "completed" | "cancelled";

export const REFERRAL_STATUS_LABEL: Record<ReferralStatus, string> = {
  sent: "أُرسلت — بانتظار النتيجة",
  completed: "اكتملت",
  cancelled: "أُلغيت",
};

export interface Referral {
  id: number;
  patientId: number;
  toName: string;
  toSpecialty: ReferralSpecialty;
  reason: string;
  teeth: string | null;
  urgency: ReferralUrgency;
  status: ReferralStatus;
  outcomeNote: string | null;
  doctorPartyId: number | null;
  doctorName: string | null;
  createdBy: string;
  createdAt: string;
  closedBy: string | null;
  closedAt: string | null;
}

export interface ReferralDraft {
  toName: string;
  toSpecialty: ReferralSpecialty;
  reason: string;
  teeth: string | null;
  urgency: ReferralUrgency;
}

/** أرقام FDI للأسنان الدائمة (11–48) واللبنية (51–85). */
export function isFdiTooth(value: number): boolean {
  const quadrant = Math.floor(value / 10);
  const tooth = value % 10;
  if (quadrant >= 1 && quadrant <= 4) return tooth >= 1 && tooth <= 8;
  if (quadrant >= 5 && quadrant <= 8) return tooth >= 1 && tooth <= 5;
  return false;
}

/**
 * «14، 24 34-44» ⇒ "14, 24, 34, 44" — بترتيب الكتابة وبلا تكرار.
 * أي رمزٍ ليس رقم FDI صالحًا يرفض الحقل كله: الخطاب إلى جرّاحٍ يقلع لا يحتمل رقمًا
 * مشكوكًا فيه.
 */
export function normalizeTeeth(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const tokens = raw.split(/[\s,،;؛\-/]+/).map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: true, value: null };
  const seen: number[] = [];
  for (const token of tokens) {
    const digits = token.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
    const value = Number(digits);
    if (!/^\d{2}$/.test(digits) || !isFdiTooth(value)) {
      return { ok: false, message: `«${token}» ليس رقم سنٍّ صالحًا بترقيم FDI (مثل 14 أو 36 أو 55).` };
    }
    if (!seen.includes(value)) seen.push(value);
  }
  if (seen.length > 32) return { ok: false, message: "عدد الأسنان أكبر من المعقول." };
  return { ok: true, value: seen.join(", ") };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function checkReferralDraft(input: Record<string, unknown>):
  { ok: true; value: ReferralDraft } | { ok: false; message: string } {
  const toName = text(input.toName);
  if (toName.length < 2) return { ok: false, message: "اكتب اسم الطبيب أو المركز المحال إليه." };
  if (toName.length > 120) return { ok: false, message: "اسم المحال إليه أطول من 120 حرفًا." };

  const toSpecialty = text(input.toSpecialty) as ReferralSpecialty;
  if (!REFERRAL_SPECIALTIES.includes(toSpecialty)) return { ok: false, message: "اختر تخصص المحال إليه." };

  const reason = text(input.reason);
  if (reason.length < 3) return { ok: false, message: "اكتب سبب الإحالة والمطلوب من الزميل." };
  if (reason.length > 1000) return { ok: false, message: "سبب الإحالة أطول من 1000 حرف." };

  const teeth = normalizeTeeth(text(input.teeth));
  if (!teeth.ok) return teeth;

  const urgencyRaw = text(input.urgency) || "routine";
  if (!REFERRAL_URGENCIES.includes(urgencyRaw as ReferralUrgency)) return { ok: false, message: "درجة الاستعجال غير معروفة." };

  return { ok: true, value: { toName, toSpecialty, reason, teeth: teeth.value, urgency: urgencyRaw as ReferralUrgency } };
}

/** إغلاق الإحالة: الاكتمال بنتيجةٍ اختيارية، والإلغاء بسببٍ إلزامي. */
export function checkReferralClose(input: Record<string, unknown>):
  { ok: true; value: { status: "completed" | "cancelled"; note: string | null } } | { ok: false; message: string } {
  const action = text(input.action);
  const note = text(input.note);
  if (note.length > 1000) return { ok: false, message: "الملاحظة أطول من 1000 حرف." };
  if (action === "complete") return { ok: true, value: { status: "completed", note: note || null } };
  if (action === "cancel") {
    if (note.length < 3) return { ok: false, message: "اكتب سبب إلغاء الإحالة." };
    return { ok: true, value: { status: "cancelled", note } };
  }
  return { ok: false, message: "إجراء غير معروف." };
}
