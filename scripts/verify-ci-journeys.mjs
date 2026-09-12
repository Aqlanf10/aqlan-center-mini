/**
 * سجلّ رحلات التحقق التشغيلية — مصدر الحقيقة الوحيد لما يجب أن يمرّ قبل الدمج.
 *
 * الترتيب مقصود: الأرخص أولًا (PGlite داخل العملية) فالأغلى (قواعد مؤقتة على
 * خادم PostgreSQL)، لينكشف العطب العام قبل أن تُنفق دقائق على الرحلات الطويلة.
 *
 * `needsPostgres` ليست زينة: رحلةٌ تحتاج خادمًا وتُشغَّل بلا `DATABASE_URL` تموت
 * برسالةٍ عن البيئة تُقرأ كأنها عطبٌ في الشيفرة — فتُصنَّف هنا صراحةً، ويقول
 * المُنسِّق إن كانت ستُتخطّى ولماذا، ولا يعدّ المتخطَّى ناجحًا أبدًا.
 */
export const JOURNEYS = [
  { phase: 1, name: "announcements", script: "scripts/verify-announcements.mjs", needsPostgres: false },
  { phase: 1, name: "appointments", script: "scripts/verify-appointments.mjs", needsPostgres: false },
  { phase: 1, name: "deletions", script: "scripts/verify-deletions.mjs", needsPostgres: false },
  { phase: 1, name: "messages", script: "scripts/verify-messages.mjs", needsPostgres: false },
  { phase: 1, name: "reports", script: "scripts/verify-reports.mjs", needsPostgres: false },
  { phase: 1, name: "settings", script: "scripts/verify-settings.mjs", needsPostgres: false },
  { phase: 1, name: "workflow", script: "scripts/verify-workflow.mjs", needsPostgres: false },

  { phase: 2, name: "audit", script: "scripts/verify-audit.mjs", needsPostgres: true },
  { phase: 2, name: "clinical", script: "scripts/verify-clinical.mjs", needsPostgres: true },
  { phase: 2, name: "concurrency", script: "scripts/verify-concurrency.mjs", needsPostgres: true },
  { phase: 2, name: "documents", script: "scripts/verify-documents.mjs", needsPostgres: true },
  { phase: 2, name: "identity", script: "scripts/verify-identity.mjs", needsPostgres: true },
  { phase: 2, name: "inventory", script: "scripts/verify-inventory.mjs", needsPostgres: true },
  { phase: 2, name: "ortho", script: "scripts/verify-ortho.mjs", needsPostgres: true },
  { phase: 2, name: "plans", script: "scripts/verify-plans.mjs", needsPostgres: true },
  { phase: 2, name: "portal", script: "scripts/verify-portal.mjs", needsPostgres: true },
  { phase: 2, name: "executive", script: "scripts/verify-executive.mjs", needsPostgres: true },

  { phase: 3, name: "schema", script: "scripts/verify-schema.mjs", needsPostgres: true },

  { phase: 4, name: "backup", script: "scripts/verify-backup.mjs", needsPostgres: true },

  { phase: 5, name: "ceph", script: "scripts/verify-ceph.mjs", needsPostgres: true },
];

export const PHASE_TITLE = {
  1: "المرحلة ١ — رحلات PGlite داخل العملية (بلا خادم)",
  2: "المرحلة ٢ — رحلات PostgreSQL على قواعد مؤقتة",
  3: "المرحلة ٣ — بناء المخطط من الصفر ومطابقته بعقده",
  4: "المرحلة ٤ — تمرين النسخ والاستعادة",
  5: "المرحلة ٥ — السيفالومتري والرحلات السريرية الحرجة",
};
