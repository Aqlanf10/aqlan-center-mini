/**
 * سجل التدقيق — المنطق الخالص.
 *
 * المبدأ الخامس في الدستور: **تاريخٌ واحد قابل للتدقيق**. وهو المبدأ الوحيد الذي لا
 * يُطلب منه أن «يعمل» بل أن **يشهد**.
 *
 * والسؤال الذي يُبنى له سؤالٌ يُطرح مرة واحدة في السنة ولا جواب له بلا سجل: «من ألغى
 * فاتورة المريض الفلاني؟» و«من غيّر سعر الدولار قبل الجرد؟» و«من فتح صلاحية
 * الصندوق لهذا الموظف؟». وفي عيادة يعمل فيها أكثر من شخص، غياب الجواب ليس نقص
 * ميزة — هو أن **الثقة تُبنى على الظنّ**، وأن الخطأ الصادق لا يُفرَّق عن غيره.
 *
 * والقاعدة الحاكمة: **يُكتب ولا يُقرأ منه إلا للمراجعة، ولا يُحذف ولا يُعدَّل أبدًا** —
 * لا من الواجهة ولا من مسار برمجي. سجلٌّ يمكن محوه يشهد لمن يملك محوه وحده.
 */

/** الأفعال المسجَّلة. قائمة مغلقة عمدًا: نصٌّ حرّ يجعل السجل غير قابل للتصفية. */
export type AuditAction =
  | "invoice.create" | "invoice.cancel"
  | "payment.create" | "payment.refund"
  | "expense.create"
  | "shift.open" | "shift.close"
  | "patient.create" | "patient.update"
  | "plan.create" | "plan.installment" | "plan.status" | "plan.consent"
  | "opening_balance.set" | "opening_balance.clear"
  | "fx.revalue"
  | "journal.manual"
  | "settings.update"
  | "user.create" | "user.update" | "user.disable"
  | "backup.download" | "export.download"
  | "document.reprint"
  | "chart.record" | "visit.sign" | "visit.addendum"
  | "document.upload" | "document.remove"
  | "ceph.create" | "ceph.update" | "ceph.complete" | "ceph.discard";

export const AUDIT_LABEL: Record<AuditAction, string> = {
  "invoice.create": "إنشاء فاتورة",
  "invoice.cancel": "إلغاء فاتورة",
  "payment.create": "سند قبض",
  "payment.refund": "استرداد",
  "expense.create": "سند صرف",
  "shift.open": "فتح وردية",
  "shift.close": "إغلاق وردية وجرد",
  "patient.create": "إضافة مريض",
  "patient.update": "تعديل بيانات مريض",
  "plan.create": "إنشاء خطة علاج",
  "plan.installment": "تحصيل قسط",
  "plan.status": "تغيير حالة خطة",
  "plan.consent": "موافقة على خطة علاج",
  "opening_balance.set": "إثبات رصيد افتتاحي",
  "opening_balance.clear": "حذف رصيد افتتاحي",
  "fx.revalue": "إعادة تقييم عملة",
  "journal.manual": "قيد يدوي",
  "settings.update": "تغيير إعداد",
  "user.create": "إنشاء مستخدم",
  "user.update": "تعديل مستخدم",
  "user.disable": "تعطيل مستخدم",
  "backup.download": "تنزيل نسخة احتياطية",
  "export.download": "تصدير بيانات",
  "document.reprint": "إعادة طباعة مستند",
  "chart.record": "تثبيت حالة سن",
  "visit.sign": "توقيع زيارة",
  "visit.addendum": "ملحق على زيارة",
  "document.upload": "رفع مستند",
  "document.remove": "إخفاء مستند",
  "ceph.create": "فتح تحليل سيفالومتري",
  "ceph.update": "تحديث تحليل سيفالومتري",
  "ceph.complete": "اعتماد تحليل سيفالومتري",
  "ceph.discard": "رفض مسودة سيفالومتري",
};

/**
 * الأفعال التي تستحق **انتباهًا** عند المراجعة.
 *
 * ليست «مشبوهة» — هي التي يُسأل عنها أولًا حين يُراجَع شهر. وتمييزها في الشاشة يوفّر
 * على المالك قراءة ألف سطر ليصل إلى العشرة التي تهمّه.
 */
export const SENSITIVE_ACTIONS: AuditAction[] = [
  "invoice.cancel", "payment.refund", "opening_balance.set", "opening_balance.clear",
  "journal.manual", "fx.revalue", "settings.update", "user.create", "user.update",
  "user.disable", "backup.download", "export.download", "document.reprint",
  "visit.addendum",
];

export function isSensitive(action: AuditAction): boolean {
  return SENSITIVE_ACTIONS.includes(action);
}

export interface AuditEntry {
  id: number;
  action: AuditAction;
  /** نوع الكيان ورقمه: `invoice/42` — فيُعرف على ماذا وقع الفعل. */
  entity: string | null;
  entityId: string | null;
  /** وصفٌ عربي جاهز للقراءة: السجل يُقرأ في لحظة توتّر لا في وقت فراغ. */
  summary: string;
  /** ما تغيّر — بلا أسرار ولا بيانات حسّاسة. */
  details: Record<string, unknown> | null;
  actor: string;
  actorRole: string | null;
  createdAt: string;
}

/**
 * ينظّف التفاصيل قبل الحفظ.
 *
 * السجل يُقرأ ويُصدَّر ويُطبع، فما يدخله يخرج منه. وكلمة سرّ أو رمز جلسة يتسرّب إلى
 * سطر تدقيق يبقى فيه إلى الأبد — والسجل نفسه لا يُحذف منه شيء، فلا سبيل لسحبه.
 */
const SECRET_KEYS = /pass|secret|token|hash|كلمة|سر|رمز/i;

export function sanitizeDetails(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!input) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.test(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 300) {
      clean[key] = `${value.slice(0, 300)}…`;
      continue;
    }
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** وصفٌ مختصر لسطر التدقيق — يُبنى مرة ويُخزَّن، فلا يتغيّر معناه بتغيّر الكود. */
export function describeAudit(
  action: AuditAction,
  entityLabel?: string | null,
): string {
  const base = AUDIT_LABEL[action];
  return entityLabel ? `${base} — ${entityLabel}` : base;
}
