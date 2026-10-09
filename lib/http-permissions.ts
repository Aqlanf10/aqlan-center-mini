import type { Role } from "./roles";

/**
 * (TD-04 / TD-REG-006) مصفوفة صلاحيات HTTP — مصدرٌ واحد لكل مسار API وفعل.
 *
 * لكل `app/api/**\/route.ts` مدخلٌ هنا بكل فعلٍ يصدّره، وإلا:
 *  - يرفض الباب (proxy) الطلب: مسارٌ غير مسجَّل ⇒ 404، وفعلٌ غير مسجَّل ⇒ 405 — فمسارٌ
 *    جديد لا يعمل في النشر حتى يُسجَّل هنا بقرار.
 *  - ويسقط فحص CI الثابت (`__tests__/http-permissions.test.ts`).
 *
 * معنى المدخل:
 *  - قائمة أدوار: الأدوار التي **قد** تجتاز حارس المسار نفسه (بأقصى صلاحيات المستخدم).
 *    الحارس يضيّق بعدها: ملكية المريض، صلاحيات المستخدم الفردية، البيانات نفسها.
 *    **الدور الغائب مرفوضٌ دائمًا** (401/403) — يثبته على التطبيق المبني
 *    `__tests__/security-http/http-permission-matrix.test.ts` لكل مسار وفعل ودور.
 *  - `PUBLIC`: يمرّ بلا جلسة (قائمة `PUBLIC_API` في الباب) — والمسار يحرس نفسه إن لزم.
 *  - `PORTAL`: بوابة المريض — يمرّ من الباب، والمسار يفحص جلسة البوابة الموقّعة.
 *  - `SHARED_MEDIA`: وسائط الرسائل — مفتوحة بالبادئة، والمسار يفحص جلسة الطاقم أو البوابة.
 *  - `WEBHOOK`: يطرقه مزوّد خارجي — مفتوح بالبادئة، وحارسه التوقيع أو مفتاح الاستقبال.
 *  - `INTERNAL`: مهام مجدولة بتوكن Bearer سرّي — يمرّ من باب الجلسة ويفحص السرّ.
 *
 * الرسائل العربية الدقيقة للرفض تبقى في المسارات نفسها (يعتمد عليها المستخدم والاختبارات)؛
 * هذه المصفوفة لا تغيّر سلوك أي مسار — تسجّله وتجعله قابلًا للتحقق.
 *
 * اشتُقّت المصفوفة من التطبيق المبني لا من رأي: كل دور بأقصى صلاحياته طرق كل مسار وفعل.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export type HttpAccessClass = "public" | "portal" | "shared-media" | "webhook" | "internal";
export type HttpAccess = HttpAccessClass | readonly Role[];

const PUBLIC: HttpAccess = "public";
const PORTAL: HttpAccess = "portal";
const SHARED_MEDIA: HttpAccess = "shared-media";
const WEBHOOK: HttpAccess = "webhook";
const INTERNAL: HttpAccess = "internal";

/** المدير وحده. */
const ADMIN: readonly Role[] = ["admin"];
/** التشغيل السريري اليومي: المدير والاستقبال والطبيب. */
const CLINIC: readonly Role[] = ["admin", "reception", "doctor"];
/** مكتب الاستقبال: المدير والاستقبال. */
const FRONT_DESK: readonly Role[] = ["admin", "reception"];
/** السريري الخالص: المدير (بهوية سريرية) والطبيب. */
const CLINICAL: readonly Role[] = ["admin", "doctor"];

export const HTTP_PERMISSIONS: Readonly<Record<string, Readonly<Partial<Record<HttpMethod, HttpAccess>>>>> = {
  "/api/accounting": { GET: ["admin", "accountant"], POST: ADMIN },
  "/api/ai/chat": { POST: CLINIC },
  "/api/ai/confirmation": { POST: CLINIC },
  "/api/appointments": { GET: CLINIC, POST: CLINIC },
  "/api/appointments/[id]": { PATCH: CLINIC, DELETE: ADMIN },
  "/api/appointments/availability": { GET: CLINIC },
  "/api/audit": { GET: ADMIN },
  "/api/auth/login": { POST: PUBLIC },
  "/api/auth/logout": { POST: PUBLIC },
  "/api/auth/me": { GET: PUBLIC },
  "/api/auth/password": { POST: ["admin", "reception", "doctor", "assistant", "cashier", "accountant"] },
  "/api/auth/setup": { POST: PUBLIC },
  "/api/backup": { GET: ADMIN },
  "/api/backup/documents": { GET: ADMIN },
  "/api/backup/full": { GET: ADMIN },
  "/api/book": { POST: PUBLIC },
  "/api/booking-requests": { GET: FRONT_DESK },
  "/api/booking-requests/[id]": { PATCH: FRONT_DESK },
  "/api/cases/[id]": { PATCH: CLINIC },
  "/api/ceph-reference-sets": { GET: CLINIC },
  "/api/ceph/[id]": { GET: CLINIC, PATCH: CLINIC, DELETE: CLINIC },
  "/api/ceph/[id]/ai-analyze": { POST: CLINIC },
  "/api/ceph/[id]/complete": { POST: CLINIC },
  "/api/ceph/[id]/duplicate": { POST: CLINIC },
  "/api/ceph/compare": { GET: CLINICAL },
  "/api/ceph/superimpose": { GET: CLINICAL },
  // الاستعلام العام عن الطابور (كشاشة الصالة) مفتوح؛ متابعة تذكرةٍ أو هاتفٍ والحضور الذاتي بجلسة البوابة.
  "/api/checkin": { GET: PUBLIC, POST: PORTAL },
  "/api/display": { GET: PUBLIC },
  "/api/display/notice": { GET: CLINIC, PATCH: CLINIC },
  "/api/documents/[id]": { GET: CLINIC, DELETE: ADMIN },
  "/api/executive": { GET: CLINICAL },
  "/api/expense-attachments/[id]": { GET: ["admin", "reception", "cashier", "accountant"] },
  "/api/expenses": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: ["admin", "reception", "cashier"], DELETE: ADMIN },
  "/api/expenses/[id]/attachments": { GET: ["admin", "reception", "cashier", "accountant"], POST: ["admin", "reception", "cashier"] },
  "/api/expenses/quote": { POST: ["admin", "reception", "cashier"] },
  "/api/export": { GET: ADMIN },
  "/api/families": { GET: FRONT_DESK, POST: FRONT_DESK },
  "/api/families/[id]": { GET: CLINIC, PATCH: FRONT_DESK },
  "/api/families/[id]/guarantor": { PUT: FRONT_DESK },
  "/api/families/[id]/members": { POST: FRONT_DESK },
  "/api/families/[id]/members/[patientId]": { DELETE: FRONT_DESK },
  "/api/finance/commission-overrides": { GET: ADMIN, POST: ADMIN },
  "/api/finance/commissions": { GET: ["admin", "doctor", "accountant"] },
  "/api/finance/debts": { GET: ["admin", "reception", "cashier", "accountant"] },
  "/api/finance/expense-categories": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: ADMIN, PATCH: ADMIN, DELETE: ADMIN },
  "/api/finance/fx": { GET: ["admin", "accountant"], POST: ADMIN },
  "/api/finance/lab-accounting": { GET: ["admin", "reception", "accountant"], PATCH: ADMIN },
  "/api/finance/lab-reconciliation": { GET: ["admin", "reception", "doctor", "accountant"], POST: ADMIN },
  "/api/finance/reconciliation": { GET: ["admin", "reception", "accountant"] },
  "/api/finance/report": { GET: ["admin", "doctor", "accountant"] },
  "/api/health": { GET: PUBLIC },
  // (HR-1) ملفات الطاقم وشروط الأجر: للمدير وحده — المبالغ لا تخرج عنه.
  "/api/hr/staff": { GET: ADMIN, POST: ADMIN },
  "/api/hr/staff/[id]": { GET: ADMIN, PATCH: ADMIN },
  // (HR-1) دليل الإسناد الآمن: بلا مبالغ — للمدير والاستقبال فقط.
  "/api/hr/directory": { GET: FRONT_DESK },
  // (HR-3) العقود والقوالب والملاحق: للمدير وحده.
  "/api/hr/contracts": { GET: ADMIN, POST: ADMIN },
  "/api/hr/contracts/[id]": { GET: ADMIN, PATCH: ADMIN, POST: ADMIN },
  // (HR-4) جداول العمل والورديات: قراءة للاستقبال، تعديل للمدير.
  "/api/hr/schedules": { GET: FRONT_DESK, POST: ADMIN },
  "/api/hr/schedules/[id]": { GET: FRONT_DESK, PATCH: ADMIN },
  // (HR-4) الحضور وتصحيحاته والإضافي:
  "/api/hr/attendance": { GET: FRONT_DESK, POST: FRONT_DESK },
  "/api/hr/attendance/corrections": { GET: ADMIN, POST: ADMIN },
  // (HR-4) الإجازات والأرصدة:
  "/api/hr/leaves": { GET: CLINIC, POST: CLINIC },
  "/api/hr/leaves/[id]": { GET: CLINIC, PATCH: FRONT_DESK },
  "/api/hr/leaves/balances": { GET: CLINIC, POST: ADMIN },
  // (HR-5) المسير والصرف والسياسات: للمدير وحده.
  "/api/hr/payroll/periods": { GET: ADMIN, POST: ADMIN },
  "/api/hr/payroll/runs": { GET: ADMIN, POST: ADMIN },
  "/api/hr/payroll/disburse": { POST: ADMIN },
  "/api/hr/settings": { GET: ADMIN, PATCH: ADMIN },
  "/api/hr/reports": { GET: ADMIN },
  "/api/internal/backup/run": { POST: INTERNAL },
  "/api/internal/reminders/run": { POST: INTERNAL },
  "/api/inventory": { GET: CLINIC, POST: FRONT_DESK },
  "/api/inventory/[id]": { GET: CLINIC, PATCH: FRONT_DESK },
  "/api/inventory/[id]/movements": { POST: CLINIC },
  "/api/inventory/patient-cost": { GET: CLINIC },
  "/api/inventory/value": { GET: ADMIN },
  "/api/invoices": { GET: ["admin", "reception", "cashier", "accountant"], POST: FRONT_DESK },
  "/api/invoices/clinical-preview": { POST: FRONT_DESK },
  "/api/invoices/[id]": { GET: ["admin", "reception", "cashier", "accountant"], PATCH: FRONT_DESK },
  "/api/invoices/[id]/correct": { POST: ADMIN },
  "/api/lab": { GET: CLINIC, POST: CLINIC },
  "/api/lab/[id]": { PATCH: CLINIC, DELETE: ADMIN },
  "/api/lab/pricing": { GET: CLINIC, POST: ADMIN },
  "/api/lab/pricing/[id]": { PUT: ADMIN, DELETE: ADMIN },
  "/api/lab/services": { GET: CLINIC, POST: ADMIN },
  "/api/lab/services/[id]": { GET: CLINIC, PATCH: ADMIN, DELETE: ADMIN },
  "/api/laboratories": { GET: CLINIC, POST: ADMIN },
  "/api/laboratories/[id]": { GET: CLINIC, PATCH: ADMIN, DELETE: ADMIN },
  "/api/messages": { GET: CLINIC, POST: CLINIC, PATCH: CLINIC, DELETE: CLINIC },
  "/api/messages/file/[id]": { GET: SHARED_MEDIA },
  "/api/messages/outbound": { GET: FRONT_DESK, POST: FRONT_DESK },
  "/api/messages/voice/[id]": { GET: SHARED_MEDIA },
  "/api/opening-balances": { GET: ["admin", "accountant"], POST: FRONT_DESK, DELETE: ADMIN },
  "/api/opening-balances/access": { GET: CLINIC },
  "/api/ortho": { GET: CLINIC, POST: CLINIC },
  "/api/ortho/[id]": { GET: CLINIC, POST: CLINIC, PATCH: CLINIC },
  "/api/ortho/adjustments/[id]/billing-decision": { POST: CLINIC },
  "/api/ortho/baseline": { POST: CLINICAL },
  "/api/ortho/billing-decisions": { GET: CLINIC },
  "/api/ortho/followups": { GET: CLINIC },
  "/api/parties": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: ADMIN },
  "/api/parties/[id]": { PATCH: ADMIN },
  "/api/party-openings": { GET: ADMIN, POST: ADMIN, PATCH: ADMIN },
  "/api/patients": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: CLINIC },
  "/api/patients/[id]": { GET: ["admin", "reception", "doctor", "assistant"], PATCH: CLINIC, DELETE: ADMIN },
  "/api/patients/[id]/arrival-panel": { GET: ["admin", "reception", "doctor", "cashier"] },
  "/api/patients/[id]/cases": { GET: CLINIC, POST: CLINICAL },
  "/api/patients/[id]/ceph": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/chart": { GET: CLINIC, POST: CLINICAL },
  "/api/patients/[id]/contact": { GET: CLINIC, POST: FRONT_DESK },
  "/api/patients/[id]/diagnoses": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/documents": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/endo": { GET: CLINIC, POST: CLINICAL },
  "/api/patients/[id]/endo/[treatmentId]": { PATCH: CLINICAL },
  "/api/patients/[id]/endo/[treatmentId]/crown": { PATCH: CLINICAL },
  "/api/patients/[id]/endo/[treatmentId]/visits": { PUT: CLINICAL },
  "/api/patients/[id]/endo/[treatmentId]/visits/[endoVisitId]/addenda": { POST: CLINICAL },
  "/api/patients/[id]/family": { GET: CLINIC },
  "/api/patients/[id]/intake-history": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/ledger": { GET: ["admin", "reception", "doctor", "cashier", "accountant"] },
  "/api/patients/[id]/legacy": { GET: CLINIC },
  "/api/patients/[id]/legacy-balance-arrangement": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: FRONT_DESK, PATCH: FRONT_DESK },
  "/api/patients/[id]/legacy-onboarding": { GET: CLINIC },
  "/api/patients/[id]/legacy-treatments": { GET: CLINIC, POST: FRONT_DESK },
  "/api/patients/[id]/legacy-treatments/preview": { POST: FRONT_DESK },
  "/api/patients/[id]/legacy-treatments/[agreementId]/void": { GET: ADMIN, POST: ADMIN },
  "/api/patients/[id]/materials": { GET: CLINIC },
  "/api/patients/[id]/medical-history": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/merge": { POST: ADMIN },
  "/api/patients/[id]/photo": { PUT: CLINIC },
  "/api/patients/[id]/plans": { GET: CLINIC },
  "/api/patients/[id]/prescriptions": { GET: CLINICAL },
  "/api/patients/[id]/problems": { GET: CLINIC, POST: CLINICAL },
  "/api/patients/[id]/referrals": { GET: CLINIC, POST: CLINICAL },
  "/api/patients/[id]/timeline": { GET: CLINIC },
  "/api/patients/[id]/vitals": { GET: CLINIC, POST: CLINIC },
  "/api/patients/[id]/workflow": { GET: ["admin", "reception", "doctor", "assistant"] },
  "/api/patients/import": { POST: ADMIN },
  "/api/patients/import/legacy": { POST: ADMIN },
  "/api/payables": { GET: ["admin", "reception", "accountant"], POST: FRONT_DESK },
  "/api/payments": { GET: ["admin", "reception", "cashier", "accountant"], POST: ["admin", "reception", "cashier"] },
  "/api/payments/[id]/correct": { POST: ADMIN },
  "/api/ping": { GET: PUBLIC },
  "/api/plan-items/[id]/case": { PUT: CLINIC },
  "/api/plan-items/[id]/dependencies": { POST: CLINIC, DELETE: CLINIC },
  "/api/plan-templates": { GET: CLINIC },
  "/api/planned-visits/[id]/schedule": { POST: CLINIC },
  "/api/plans": { GET: ["admin", "reception", "cashier", "accountant"], POST: CLINIC },
  "/api/plans/[id]": { POST: FRONT_DESK, PATCH: FRONT_DESK },
  "/api/plans/[id]/consent": { POST: FRONT_DESK },
  "/api/plans/[id]/items": { POST: CLINIC, PATCH: CLINIC, DELETE: CLINIC },
  "/api/plans/proposals": { GET: FRONT_DESK, POST: FRONT_DESK },
  "/api/plans/reminders": { POST: CLINIC },
  "/api/portal/appointments": { GET: PORTAL },
  "/api/portal/appointments/confirm": { POST: PORTAL },
  "/api/portal/intake": { GET: PORTAL, POST: PORTAL },
  "/api/portal/login": { POST: PUBLIC },
  "/api/portal/logout": { POST: PUBLIC },
  "/api/portal/me": { GET: PORTAL },
  "/api/portal/messages": { GET: PORTAL, POST: PORTAL, PATCH: PORTAL, DELETE: PORTAL },
  "/api/portal/statement": { GET: PORTAL },
  "/api/prescriptions": { POST: CLINICAL },
  "/api/prescriptions/[id]/void": { POST: CLINICAL },
  "/api/print-log": { POST: ["admin", "reception", "doctor", "cashier", "accountant"] },
  "/api/problems/[id]": { PATCH: CLINIC },
  "/api/provider-blocks": { GET: CLINIC, POST: ADMIN },
  "/api/provider-blocks/[id]": { DELETE: ADMIN },
  "/api/recall": { GET: CLINIC, POST: FRONT_DESK },
  "/api/referrals/[id]": { PATCH: CLINIC },
  "/api/referrals/[id]/transition": { POST: CLINIC },
  "/api/referrals/mine": { GET: CLINICAL },
  "/api/report": { GET: CLINIC },
  "/api/reports": { GET: ["admin", "accountant"] },
  "/api/reports/daily-clinic": { GET: ADMIN },
  "/api/reports/saved": { GET: ["admin", "reception", "doctor", "accountant"], POST: CLINIC, PATCH: CLINIC, DELETE: CLINIC },
  "/api/service-materials": { GET: CLINIC, POST: FRONT_DESK, DELETE: FRONT_DESK },
  "/api/services": { GET: ["admin", "reception", "doctor", "accountant"], POST: ADMIN },
  "/api/services/[id]": { PATCH: ADMIN },
  "/api/services/prices": { POST: ADMIN },
  "/api/services/provisional": { POST: ADMIN },
  "/api/settings": { GET: CLINIC, POST: CLINIC, PATCH: CLINIC },
  "/api/settings/ai": { GET: ADMIN, PUT: ADMIN },
  "/api/settings/ai/providers": { GET: ADMIN, POST: ADMIN },
  "/api/settings/ai/providers/[id]": { PUT: ADMIN, DELETE: ADMIN },
  "/api/settings/ai/providers/[id]/test": { POST: ADMIN },
  "/api/settings/ai/providers/reorder": { POST: ADMIN },
  "/api/settings/ai/test": { POST: ADMIN },
  "/api/settings/appointment-services": { GET: CLINIC, POST: ADMIN },
  "/api/settings/appointment-services/[id]": { PATCH: ADMIN },
  "/api/settings/backup": { GET: ADMIN },
  "/api/settings/backup/archive/[backupId]": { DELETE: ADMIN },
  "/api/settings/backup/config": { GET: CLINIC, POST: ADMIN },
  "/api/settings/backup/restore": { GET: CLINIC, POST: ADMIN },
  "/api/settings/backup/run": { GET: CLINIC, POST: ADMIN },
  "/api/settings/display/announcements": { GET: CLINIC, POST: ADMIN },
  "/api/settings/display/announcements/[id]": { PATCH: ADMIN, DELETE: ADMIN },
  "/api/settings/display/announcements/reorder": { PATCH: ADMIN },
  "/api/settings/history": { GET: ADMIN },
  "/api/settings/material-rates": { GET: CLINIC, POST: ADMIN },
  "/api/settings/messaging": { GET: ADMIN, PUT: ADMIN },
  "/api/settings/messaging/test": { POST: ADMIN },
  "/api/settings/production-backup": { POST: ADMIN },
  "/api/settings/readiness": { GET: ADMIN },
  "/api/settings/reset": { GET: ADMIN, POST: ADMIN },
  "/api/shifts": { GET: ["admin", "reception", "doctor", "cashier", "accountant"], POST: ["admin", "reception", "cashier"], PATCH: ["admin", "reception", "cashier"] },
  // (HR-2) المهام: الأدوار غير المقيّدة (المدير والاستقبال والطبيب) — الخصوصية والرؤية
  // على مستوى الصف داخل المسار، ودورا المال المقيّدان والمساعد مرفوضان عند الباب.
  "/api/tasks": { GET: CLINIC, POST: CLINIC },
  "/api/tasks/[id]": { GET: CLINIC, PATCH: CLINIC },
  "/api/tasks/[id]/comments": { POST: CLINIC },
  "/api/tasks/[id]/checklist": { POST: CLINIC },
  "/api/tasks/[id]/links": { POST: CLINIC, DELETE: CLINIC },
  "/api/users": { GET: ADMIN, POST: ADMIN },
  "/api/users/[id]": { PATCH: ADMIN },
  "/api/visits": { GET: ["admin", "reception", "doctor", "assistant"], POST: CLINIC },
  "/api/visits/[id]": { PATCH: CLINIC, DELETE: ADMIN },
  "/api/visits/[id]/billing-preview": { GET: CLINIC },
  "/api/visits/[id]/clinical": { GET: ["admin", "reception", "doctor", "assistant"], POST: ["admin", "doctor", "assistant"] },
  "/api/visits/[id]/materials": { GET: CLINIC },
  "/api/visits/[id]/next": { POST: CLINIC },
  "/api/visits/[id]/walkout": { GET: CLINIC },
  "/api/visits/readiness": { GET: ["admin", "reception", "doctor", "assistant"] },
  "/api/waiting-list": { GET: CLINIC, POST: CLINIC },
  "/api/waiting-list/[id]": { GET: CLINIC, PATCH: CLINIC },
  "/api/webhooks/sms": { GET: WEBHOOK, POST: WEBHOOK },
  "/api/webhooks/whatsapp": { GET: WEBHOOK, POST: WEBHOOK },
};

/** هل المدخل فئةٌ غير طاقمية (عامة/بوابة/وسائط/خطاف/داخلي)؟ */
export function isAccessClass(access: HttpAccess): access is HttpAccessClass {
  return typeof access === "string";
}

interface CompiledPattern {
  pattern: string;
  segments: string[];
}

const COMPILED: CompiledPattern[] = Object.keys(HTTP_PERMISSIONS).map((pattern) => ({
  pattern,
  segments: pattern.split("/").slice(1),
}));

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

/**
 * نمط المسار المسجَّل الذي يخدم هذا العنوان — كما يختاره Next: المقطع الثابت يغلب
 * المقطع المتغيّر في أول موضعٍ يختلفان فيه. لا مطابقة ⇒ null.
 */
export function matchApiRoute(pathname: string): string | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const parts = trimmed.split("/").slice(1);
  let best: CompiledPattern | null = null;
  let bestScore: number[] = [];
  for (const candidate of COMPILED) {
    if (candidate.segments.length !== parts.length) continue;
    let matches = true;
    const score: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const segment = candidate.segments[index];
      if (isDynamic(segment)) {
        if (!parts[index]) { matches = false; break; }
        score.push(0);
      } else if (segment === parts[index]) {
        score.push(1);
      } else {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (!best || compareScores(score, bestScore) > 0) {
      best = candidate;
      bestScore = score;
    }
  }
  return best?.pattern ?? null;
}

function compareScores(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export type ApiRouteVerdict =
  | { kind: "unknown-route" }
  | { kind: "method-not-allowed"; pattern: string; allow: string[] }
  | { kind: "registered"; pattern: string; access: HttpAccess | null };

/**
 * حكم الباب على طلب API: مسارٌ غير مسجَّل، أو فعلٌ غير مسجَّل، أو مسجَّل.
 * HEAD يتبع GET، وOPTIONS يمرّ (Next يجيبه بنفسه) — `access` عندها null.
 */
export function apiRouteVerdict(pathname: string, method: string): ApiRouteVerdict {
  const pattern = matchApiRoute(pathname);
  if (!pattern) return { kind: "unknown-route" };
  const entry = HTTP_PERMISSIONS[pattern];
  const verb = method.toUpperCase();
  if (verb === "OPTIONS") return { kind: "registered", pattern, access: null };
  const lookup = (verb === "HEAD" ? "GET" : verb) as HttpMethod;
  const access = entry[lookup];
  if (access === undefined) {
    // ترويسة Allow كاملة: ما يصدّره المسار، وHEAD مع GET (Next يجيبه)، وOPTIONS دائمًا.
    const allow: string[] = HTTP_METHODS.filter((name) => entry[name] !== undefined);
    if (entry.GET !== undefined) allow.splice(allow.indexOf("GET") + 1, 0, "HEAD");
    allow.push("OPTIONS");
    return { kind: "method-not-allowed", pattern, allow };
  }
  return { kind: "registered", pattern, access };
}

/** الأدوار التي يرفضها المسار دائمًا لهذا الفعل — لاختبار المصفوفة على HTTP. */
export function rolesAlwaysDenied(access: HttpAccess, roles: readonly Role[]): Role[] {
  if (isAccessClass(access)) return [];
  return roles.filter((role) => !access.includes(role));
}

export const API_ROUTE_UNKNOWN_MESSAGE = "هذا المسار غير موجود.";
export const API_METHOD_NOT_ALLOWED_MESSAGE = "هذه العملية غير مدعومة على هذا المسار.";

