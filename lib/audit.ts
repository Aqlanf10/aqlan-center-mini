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
  | "plan.create" | "plan.create_v2" | "plan.installment" | "plan.status" | "plan.consent"
  | "opening_balance.set" | "opening_balance.clear"
  | "fx.revalue"
  | "journal.manual"
  | "settings.update"
  | "user.create" | "user.update" | "user.disable"
  | "doctor.permissions.update" | "doctor.commission.update"
  | "backup.download" | "export.download"
  | "document.reprint"
  | "chart.record" | "visit.sign" | "visit.addendum"
  | "document.upload" | "document.remove"
  | "ceph.create" | "ceph.update" | "ceph.complete" | "ceph.discard"
  | "inventory.item" | "inventory.move"
  | "lab.create" | "lab.update" | "lab.delete"
  | "lab_order.cancel" | "lab_order.delete"
  | "lab_service.create" | "lab_service.update" | "lab_service.delete" | "lab_service.deactivate" | "lab_services.seed"
  | "lab_pricing.create" | "lab_pricing.update" | "lab_pricing.delete"
  | "lab.accounting.update"
  | "portal.login" | "portal.confirm" | "portal.intake" | "portal.message"
  | "display.delay_notice"
  | "display.announcement.create" | "display.announcement.update" | "display.announcement.delete"
  | "display.announcement.reorder" | "display.announcement.migrate"
  | "ai.settings.update" | "ai.test" | "ai.suggest"
  | "diagnosis.create" | "ortho.book_next"
  | "patient.delete" | "appointment.delete" | "visit.delete" | "expense.delete";

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
  "plan.create_v2": "إنشاء خطة علاج (رحلة موحَّدة)",
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
  "doctor.permissions.update": "تعديل صلاحيات الطبيب",
  "doctor.commission.update": "تعديل نسبة/طريقة احتساب الطبيب",
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
  "inventory.item": "إدارة بند مخزون",
  "inventory.move": "حركة مخزون",
  "lab.create": "إضافة مختبر جديد",
  "lab.update": "تعديل بيانات مختبر",
  "lab.delete": "حذف/تعطيل مختبر",
  "lab_order.cancel": "إلغاء إرسالية مختبر",
  "lab_order.delete": "حذف أمر مختبر نهائيًا",
  "lab_service.create": "إضافة خدمة مختبر",
  "lab_service.update": "تعديل خدمة مختبر",
  "lab_service.delete": "حذف خدمة مختبر",
  "lab_service.deactivate": "تعطيل خدمة مختبر",
  "lab_services.seed": "بذر دليل خدمات المختبر",
  "lab_pricing.create": "إضافة قاعدة تسعير مختبر",
  "lab_pricing.update": "تعديل قاعدة تسعير مختبر",
  "lab_pricing.delete": "حذف قاعدة تسعير مختبر",
  "lab.accounting.update": "تعديل الربط المحاسبي لمختبر",
  "portal.login": "دخول مريض إلى البوابة",
  "portal.confirm": "تأكيد حضور موعد (بوابة)",
  "portal.intake": "استمارة صحية من البوابة",
  "portal.message": "رسالة من بوابة المريض",
  "display.delay_notice": "تشغيل/إيقاف رسالة الاعتذار على شاشة الصالة",
  "display.announcement.create": "إضافة إعلان لشاشة الصالة",
  "display.announcement.update": "تعديل إعلان شاشة الصالة",
  "display.announcement.delete": "حذف إعلان شاشة الصالة",
  "display.announcement.reorder": "ترتيب إعلانات شاشة الصالة",
  "display.announcement.migrate": "ترحيل إعلانات الصالة القديمة إلى السجلات",
  "ai.settings.update": "تغيير إعدادات الذكاء الاصطناعي",
  "ai.test": "اختبار اتصال الذكاء الاصطناعي",
  "ai.suggest": "اقتراح من الذكاء الاصطناعي (غير معتمد)",
  "patient.delete": "حذف ملف مريض نهائيًا بكل سجلاته",
  "appointment.delete": "حذف موعد",
  "visit.delete": "حذف زيارة",
  "expense.delete": "حذف سند صرف",
  "diagnosis.create": "فتح نسخة تشخيص",
  "ortho.book_next": "حجز جلسة التقويم القادمة",
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
  "user.disable", "doctor.permissions.update", "doctor.commission.update",
  "backup.download", "export.download", "document.reprint",
  "visit.addendum", "ai.settings.update",
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
