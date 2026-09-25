/**
 * (P1-4) فرق «قبل/بعد» لسجل التدقيق — الحقول التي تغيّرت فقط، بأسمائها العربية.
 *
 * سطر تدقيقٍ يقول «عُدّل مريض» بلا ما تغيّر لا يجيب عن سؤال المالك: من غيّر رقم هاتف
 * هذا المريض؟ ومن رفع سعر هذه الخدمة؟ فالسجل يحمل القيمة قبل وبعد لكل حقلٍ تغيّر.
 */

export type AuditChange = { قبل: unknown; بعد: unknown };

function normalize(value: unknown): unknown {
  if (value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * يقارن الحقول المسمّاة في `labels` بين نسختين ويعيد ما تغيّر فقط، مفتاحه الاسم العربي.
 * القيم الفارغة (undefined، "") تُعامل كـnull فلا يظهر «تغيير» من لا شيء إلى لا شيء.
 */
export function auditChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  labels: Record<string, string>,
): Record<string, AuditChange> {
  const changes: Record<string, AuditChange> = {};
  for (const [key, label] of Object.entries(labels)) {
    const from = normalize(before?.[key]);
    const to = normalize(after?.[key]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[label] = { قبل: from, بعد: to };
  }
  return changes;
}

/** لقطةٌ بأسماء عربية للحقول المسمّاة — لسطر إنشاءٍ أو حذف. */
export function auditSnapshot(
  value: Record<string, unknown> | null | undefined,
  labels: Record<string, string>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, label] of Object.entries(labels)) snapshot[label] = normalize(value?.[key]);
  return snapshot;
}

export const PATIENT_AUDIT_FIELDS: Record<string, string> = {
  patientNumber: "رقم_الملف",
  fullName: "الاسم",
  phone: "الهاتف",
  altPhone: "هاتف_بديل",
  gender: "الجنس",
  birthYear: "سنة_الميلاد",
  address: "العنوان",
  medicalAlert: "تنبيه_طبي",
  note: "ملاحظة",
};

export const PARTY_AUDIT_FIELDS: Record<string, string> = {
  name: "الاسم",
  kind: "النوع",
  phone: "الهاتف",
  commissionPercent: "نسبة_العمولة",
  note: "ملاحظة",
  isActive: "نشط",
};

export const SERVICE_AUDIT_FIELDS: Record<string, string> = {
  name: "الاسم",
  category: "التخصص",
  priceMinor: "السعر",
  isActive: "نشطة",
};
