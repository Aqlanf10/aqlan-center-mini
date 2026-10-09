/**
 * (INV-LEGACY) علاجٌ بدأ قبل النظام — المنطق الخالص.
 *
 * المستخدم يُدخل: الخدمة العلاجية من الدليل (التصنيف نفسه الذي يربط بنود الفاتورة)، والسن، والمبلغ المتفق عليه
 * أصلًا، والمدفوع قبل النظام، وتاريخ المعلومات، والعملة. والرقم المشتق الوحيد: المتبقي = المتفق − المدفوع.
 * الحساب والتحقق بالدالة نفسها التي تعرض المعاينة (`previewLegacyReconciliation`) — فلا تختلف الشاشة عن الخادم.
 * لا سند للمدفوع سابقًا، ولا فاتورة بكامل الاتفاق؛ الرصيد السابق = المتبقي وحده.
 * التصميم: docs/INVOICE_FIRST_LEGACY_TREATMENT.md.
 */
import { previewLegacyReconciliation } from "./legacy-reconciliation-preview";
import {
  INVOICE_LINKAGE_MESSAGE, LINKAGE_SPECIALTY_LABEL, SITE_SCOPE_LABEL, parseLineSiteFields,
  type LineSite, type LinkageSpecialty,
} from "./invoice-clinical-linkage";
import { isValidTooth } from "./dental";
import { isCurrency, type Currency } from "./money";

export const LEGACY_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface LegacyTreatmentRequest {
  serviceId: number;
  toothCode: number | null;
  /** (INV-LINK TOOTH) أسطح الحشوة، أسنان حلقة التاج/الجسر، ونطاق التقويم/اللثة — من مخطط الأسنان نفسه. */
  surfaces: string | null;
  episodeTeeth: number[] | null;
  scope: string | null;
  caseId: number | null;
  sessions: number | null;
  currency: Currency;
  agreedMinor: number;
  previouslyPaidMinor: number;
  remainingMinor: number;
  historicalAsOf: string;
  note: string | null;
  idempotencyKey: string | null;
}

function optionalInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

function amountText(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}

/** طلب التسجيل → قيمٌ مؤكَّدة، أو أول خطأ برسالةٍ عربية. `today` يوم العيادة (لا ساعة هنا). */
export function parseLegacyTreatmentRequest(source: Record<string, unknown>, today: string):
  | { ok: true; value: LegacyTreatmentRequest }
  | { ok: false; message: string } {
  const serviceId = Number(source.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) return { ok: false, message: "اختر الخدمة العلاجية من الدليل." };
  const toothCode = optionalInt(source.toothCode, 11, 85);
  if (toothCode === undefined || (toothCode !== null && !isValidTooth(toothCode))) {
    return { ok: false, message: "رقم السن غير صحيح بالترقيم الدولي." };
  }
  const site = parseLineSiteFields(source);
  if (!site) return { ok: false, message: "بيانات موضع العلاج (الأسنان/الأسطح/النطاق) غير صالحة." };
  const caseId = optionalInt(source.caseId, 1, 2_147_483_647);
  if (caseId === undefined) return { ok: false, message: "الحالة المختارة غير صالحة." };
  const sessions = optionalInt(source.sessions, 1, 60);
  if (sessions === undefined) return { ok: false, message: "عدد الجلسات المتبقية بين ١ و٦٠." };
  if (!isCurrency(source.currency)) return { ok: false, message: "اختر عملة الاتفاق: YER أو SAR أو USD." };
  const currency = source.currency;
  const preview = previewLegacyReconciliation({
    draft: {
      currency,
      agreedAmount: amountText(source.agreedAmount),
      previouslyPaidAmount: amountText(source.previouslyPaidAmount),
      historicalAsOf: typeof source.historicalAsOf === "string" ? source.historicalAsOf : "",
    },
    today,
  });
  if (preview.draftState !== "valid" || !preview.historical) {
    return { ok: false, message: preview.message ?? "بيانات الاتفاق التاريخي غير صالحة." };
  }
  if (preview.historical.agreedMinor <= 0) {
    return { ok: false, message: "المبلغ المتفق عليه أصلًا يجب أن يكون أكبر من صفر." };
  }
  const idempotencyKey = typeof source.idempotencyKey === "string" && source.idempotencyKey.trim()
    ? source.idempotencyKey.trim() : null;
  if (idempotencyKey !== null && !LEGACY_IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return { ok: false, message: "مفتاح الطلب غير صالح." };
  }
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  return {
    ok: true,
    value: {
      serviceId, toothCode, ...site, caseId, sessions, currency, note, idempotencyKey,
      agreedMinor: preview.historical.agreedMinor,
      previouslyPaidMinor: preview.historical.previouslyPaidMinor,
      remainingMinor: preview.historical.remainingMinor,
      historicalAsOf: preview.historical.historicalAsOf,
    },
  };
}

/** بصمة الطلب لمفتاح الإعادة: كل ما يُحفظ منه — بترتيبٍ ثابت. */
export function legacyTreatmentFingerprint(patientId: number, request: LegacyTreatmentRequest): string {
  return JSON.stringify([
    patientId, request.serviceId, request.toothCode, request.surfaces, request.episodeTeeth, request.scope,
    request.caseId, request.sessions, request.currency,
    request.agreedMinor, request.previouslyPaidMinor, request.historicalAsOf, request.note,
  ]);
}

/** عنوان حالةٍ تُفتح لعلاجٍ سابق: التخصص والسن، ووسمها أنها بدأت قبل النظام — بلا تشخيص مختلق. */
export function legacyCaseTitle(specialty: LinkageSpecialty, site: Pick<LineSite, "toothCode" | "episodeTeeth" | "scope">): string {
  const where = site.episodeTeeth && site.episodeTeeth.length > 1 ? ` — أسنان ${site.episodeTeeth.join("، ")}`
    : site.toothCode !== null ? ` — سن ${site.toothCode}`
    : site.scope !== null ? ` — ${SITE_SCOPE_LABEL[site.scope]}` : "";
  return `${LINKAGE_SPECIALTY_LABEL[specialty]}${where} — حالة بدأت قبل النظام`;
}

export const LEGACY_CASE_LABEL = "حالة بدأت قبل النظام";

export type LegacyTreatmentRefusal =
  | "no_patient" | "bad_service" | "bad_tooth" | "bad_case" | "ambiguous_case" | "idempotency_conflict"
  | "duplicate_live" | "open_item_exists" | "opening_not_owned" | "opening_edit_forbidden" | "period_locked"
  | "opening_changed" | "tooth_required" | "episode_split_required" | "bad_surfaces" | "bad_scope"
  | "incompatible_plan" | "needs_financial_review" | "legacy_episode_unsupported" | "prior_receipts_review"
  | "ortho_scope_mismatch";

/**
 * (LEGACY-FIX) معاينة التسجيل كما سيقرّرها الحفظ: الحالة التي سيُربط بها، وأثر الرصيد السابق.
 * `case`/`opening` فارغان حين يكون الطلب نفسه محفوظًا بالمفتاح ذاته (إعادة إرسال).
 */
export interface LegacyTreatmentPreview {
  case: { mode: "none" | "existing" | "new" | "bridge" | "choose"; id: number | null; title: string | null;
    options: { id: number; title: string }[] } | null;
  opening: { effect: "none" | "created" | "increased"; beforeMinor: number | null; afterMinor: number | null; currency: Currency } | null;
}

export type LegacyVoidRefusal =
  | "not_found" | "already_void" | "opening_settled" | "opening_changed" | "period_locked" | "bad_reason"
  | "opening_collected" | "void_forbidden" | "bad_void_request" | "preview_required" | "preview_stale";

export const LEGACY_TREATMENT_MESSAGE: Record<LegacyTreatmentRefusal | LegacyVoidRefusal, string> = {
  no_patient: "المريض غير موجود.",
  incompatible_plan: "الخطة الرئيسية القائمة غير قابلة لإضافة العلاج السابق؛ راجع خطط المريض وموافقاتها وعملتها قبل المتابعة.",
  ortho_scope_mismatch: "حالة التقويم الجارية للمريض بنطاق فكّين مختلف أو غير مسجّل عن نطاق الاتفاق التاريخي — لا يُربط بها. راجع حالة التقويم ونطاقها أولًا.",
  prior_receipts_review: "للمريض سندات قبض عامّة غير مرتبطة بفاتورة أو خطة أو رصيد سابق — قد يكون بينها مدفوعٌ قديم أُدخل كتحصيل، فيُخصم مرتين لو سُجّل «المدفوع قبل النظام» فوقه. لا يصنّف النظام السند من ملاحظته ولا يعكسه: تحتاج الحالة مراجعة وتسوية من المدير قبل تسجيل الاتفاق؛ هذا الإجراء لا يصحّحها تلقائيًا.",
  needs_financial_review: "هذا العمل له سجل مالي أو اتفاق تاريخي يحتاج مراجعة؛ لا يُعاد تسجيله أو فوترته بهوية جديدة.",
  legacy_episode_unsupported: "تسجيل اتفاق تاريخي لعدة أسنان متوقف مؤقتًا حتى يدعم النظام تغطية الحلقة كاملةً بأمان؛ لا تقسّم مبلغ الاتفاق أو المدفوع على الأسنان تخمينًا.",
  bad_service: "اختر خدمةً علاجية من الدليل (تقويم، علاج جذور، تركيبات، زراعة…) — الكشف والأشعة ليست علاجًا سابقًا.",
  bad_tooth: "رقم السن غير صحيح بالترقيم الدولي.",
  bad_case: "الحالة المختارة لا تطابق مريض العلاج وتخصصه وموضعه أو لم تعد مفتوحة.",
  ambiguous_case: "للمريض أكثر من حالة مفتوحة لهذا التخصص — اختر الحالة التي يرتبط بها العلاج السابق.",
  idempotency_conflict: "هذا الطلب أُرسل سابقًا ببياناتٍ مختلفة — أعد فتح النموذج.",
  duplicate_live: "للمريض اتفاقٌ تاريخي قائم لنفس العلاج والسن — لا يُسجَّل مرتين.",
  open_item_exists: "للمريض بند خطة مفتوح لنفس العلاج والسن في النظام — لا يُسجَّل علاجٌ سابق فوقه. استخدم هوية العمل القائمة أو راجع سجلها المالي أولًا.",
  opening_not_owned: "للمريض رصيدٌ سابق بهذه العملة لم يُسجَّل من اتفاق علاجٍ سابق — قد يشمل هذا العلاج فيُحسب مرتين. يراجعه المدير ويصحّحه أولًا ثم يُسجَّل الاتفاق.",
  opening_edit_forbidden: "للمريض رصيدٌ سابق بهذه العملة — إضافة متبقي اتفاقٍ آخر إليه للمدير.",
  period_locked: "تاريخ الرصيد السابق في فترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال أو راجع المدير.",
  opening_changed: "تغيّر الرصيد السابق لهذه العملة بعد تسجيل الاتفاق — يراجعه المدير قبل الإبطال.",
  tooth_required: INVOICE_LINKAGE_MESSAGE.tooth_required,
  episode_split_required: "العلاج السابق للعصب/الزراعة/الخلع اتفاقٌ مستقل لكل سن — سجّل كل سنٍّ وحده.",
  bad_surfaces: INVOICE_LINKAGE_MESSAGE.bad_surfaces,
  bad_scope: INVOICE_LINKAGE_MESSAGE.bad_scope,
  not_found: "الاتفاق التاريخي غير موجود لهذا المريض.",
  already_void: "هذا الاتفاق التاريخي مُبطَل مسبقًا.",
  opening_settled: "سُدِّد من الرصيد السابق ما لا يبقى مغطًّى بعد إبطال الاتفاق — الإبطال المصرّح به غير مسموح. يلزم مسار مراجعة مالية مستقل؛ لا يُنشأ ردّ أو تصحيح سند تلقائيًا.",
  opening_collected: "توجد تحصيلات صافية على الرصيد السابق للمريض بهذه العملة؛ الإبطال العادي متوقف. راجع الأثر المالي واستخدم الإبطال المصرّح به للمدير إن بقي أصلٌ يغطي التحصيلات.",
  void_forbidden: "إبطال العلاج السابق للنظام ورصيده للمدير وحده.",
  bad_void_request: "طلب الإبطال أو نوعه غير صالح.",
  preview_required: "اعرض الأثر المالي الحالي قبل تأكيد الإبطال المصرّح به للمدير.",
  preview_stale: "تغيّرت بيانات المعاينة المالية؛ أعد تحميل الأثر المالي وراجعه قبل التأكيد.",
  bad_reason: "اكتب سبب إبطال الاتفاق (من ثلاثة إلى ٣٠٠ حرف).",
};

export const LEGACY_TREATMENT_STATUS: Record<LegacyTreatmentRefusal | LegacyVoidRefusal, number> = {
  opening_collected: 409, void_forbidden: 403, bad_void_request: 400, preview_required: 400, preview_stale: 409,
  incompatible_plan: 409, needs_financial_review: 409, prior_receipts_review: 409, ortho_scope_mismatch: 409, legacy_episode_unsupported: 400,
  no_patient: 404, bad_service: 400, bad_tooth: 400, bad_case: 400, ambiguous_case: 409, idempotency_conflict: 409,
  duplicate_live: 409, open_item_exists: 409, opening_not_owned: 409, opening_edit_forbidden: 403, period_locked: 409,
  opening_changed: 409, tooth_required: 400, episode_split_required: 400, bad_surfaces: 400, bad_scope: 400, not_found: 404, already_void: 409, opening_settled: 409, bad_reason: 400,
};

