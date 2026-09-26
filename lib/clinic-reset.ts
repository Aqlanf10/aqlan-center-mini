/**
 * إعادة الضبط — مسح البيانات التجريبية وإبقاء الإعداد (قرار المالك).
 *
 * المركز جرّب النظام ببياناتٍ تجريبية، ثم يبدأ عمله الحقيقي من الصفر: فتُمسح المرضى
 * وكل ما تعلّق بهم والمال والتشغيل، ويبقى ما أُعدّ مرةً ليُستعمل كل يوم — المستخدمون
 * والإعدادات والخدمات بأسعارها والأطباء والمختبرات وبنود المصروفات وأصناف المخزون.
 *
 * كل جدولٍ في القاعدة مصنَّف هنا **صراحةً** في إحدى القائمتين؛ واختبارٌ على القاعدة
 * الحقيقية يسقط إن ظهر جدولٌ جديد غير مصنَّف — فلا يُمسح جدولٌ بالخطأ ولا يبقى
 * جدولٌ تجريبي منسيًّا.
 *
 * وسجل التدقيق **لا يُمسح أبدًا**: السجل الذي يمكن محوه يشهد لمن يملك محوه. تُكتب فيه
 * إعادة الضبط نفسها — من نفّذها ومتى وكم مُسح ومعرّف النسخة الاحتياطية قبلها.
 */

/** ما يُمسح — مرتّبًا من الأطراف إلى الأصول (للقراءة؛ المسح في أمر TRUNCATE واحد). */
export const RESET_WIPE_TABLES = [
  // التشغيل اليومي
  "ai_confirmation_claims",
  "document_prints",
  "message_reads",
  "messages",
  "waiting_list_contact_events",
  "waiting_list",
  "booking_requests",
  "appointment_status_log",
  "provider_blocks",
  // السريري
  "ceph_diagnoses",
  "ceph_measurements",
  "ceph_landmarks",
  "ceph_analyses",
  "ortho_adjustments",
  "ortho_cases",
  "tooth_conditions",
  "prescriptions",
  "patient_referrals",
  "patient_intake_forms",
  // أرشيف النظام القديم (P1-5ج) — للقراءة، يُمسح مع مرضاه
  "legacy_payments",
  "legacy_treatments",
  "patient_diagnoses",
  "patient_documents",
  "treatment_sessions",
  "visit_procedures",
  "planned_visits",
  // المختبر والمخزون
  "lab_order_tracking",
  "lab_orders",
  "inventory_movements",
  // المال
  "journal_manual_lines",
  "journal_manual",
  "expense_payable_allocations",
  "expense_attachments",
  "expenses",
  "payables",
  "payments",
  "invoice_items",
  "invoices",
  "plan_installments",
  "plan_items",
  "treatment_plans",
  "cashier_shifts",
  "patient_opening_balance_history",
  "patient_opening_balances",
  // الأصول
  "visits",
  "appointments",
  "patients",
] as const;

/** ما يبقى — الإعداد الذي لا يُعاد تجهيزه، وسجل التدقيق، وسجل الهجرات. */
export const RESET_KEEP_TABLES = [
  "users",
  "settings",
  "parties",
  "doctor_commission_history",
  "services",
  "service_materials",
  "appointment_services",
  "lab_services",
  "lab_pricing_rules",
  "expense_categories",
  "inventory_items",
  "material_rates",
  "material_rate_history",
  "ceph_reference_sets",
  "ceph_reference_values",
  "display_announcements",
  "saved_reports",
  "ai_providers",
  "ai_settings",
  "login_limits",
  "staff_login_limits",
  "audit_log",
  "schema_migrations",
] as const;

/** ترقيم المستندات وملفات المرضى — يعود إلى ١ مع البداية الجديدة. */
export const RESET_SEQUENCES = [
  "patient_number_seq",
  "invoice_number_seq",
  "receipt_number_seq",
  "voucher_number_seq",
] as const;

/** الجداول التي تحمل ملفات على القرص (مفتاح التخزين) — تُحذف ملفاتها بعد نجاح المسح. */
export const RESET_FILE_TABLES = ["patient_documents", "expense_attachments"] as const;

/** عبارة التأكيد — تُكتب حرفيًّا؛ لا زرٌّ يُضغط سهوًا. */
export const RESET_CONFIRM_PHRASE = "امسح البيانات التجريبية";

/** مجموعات العرض في شاشة التأكيد: كم سيُمسح من كل نوع. */
export const RESET_PREVIEW_GROUPS: { label: string; table: (typeof RESET_WIPE_TABLES)[number] }[] = [
  { label: "المرضى", table: "patients" },
  { label: "المواعيد", table: "appointments" },
  { label: "الزيارات", table: "visits" },
  { label: "خطط العلاج", table: "treatment_plans" },
  { label: "حالات التقويم", table: "ortho_cases" },
  { label: "تحاليل السيفالو", table: "ceph_analyses" },
  { label: "الأشعة والمستندات", table: "patient_documents" },
  { label: "الفواتير", table: "invoices" },
  { label: "سندات القبض", table: "payments" },
  { label: "سندات الصرف", table: "expenses" },
  { label: "الورديات", table: "cashier_shifts" },
  { label: "أوامر المختبر", table: "lab_orders" },
  { label: "حركات المخزون", table: "inventory_movements" },
  { label: "الرسائل", table: "messages" },
  { label: "معالجات النظام القديم (أرشيف)", table: "legacy_treatments" },
];

export function isResetPhrase(value: unknown): boolean {
  return typeof value === "string" && value.trim().replace(/\s+/g, " ") === RESET_CONFIRM_PHRASE;
}
