"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CLINIC_BASE_CURRENCY, formatAmount, formatMoney, isCurrency, parseAmount, type Currency } from "@/lib/money";
import { isValidTooth, toothName } from "@/lib/dental";
import { LAB_STATUS_LABEL, type LabOrderStatus } from "@/lib/lab";
import { ToothField } from "./ToothPicker";
import { visitTotal } from "@/lib/clinical";
import { PrescriptionModal } from "./PrescriptionModal";
import { PostOpModal } from "./PostOpModal";
import {
  BILLING_RULE_LABEL, isBillingRule, labWorkForCategory, priceForSession, sessionPriceNote,
  type BillingRule,
} from "@/lib/workflow";
import { useSession } from "./SessionProvider";
import { useSetting } from "./SettingsProvider";
import {
  appendPhrase, parsePhraseList, treatmentDoneFromProcedures, type VisitSuggestions,
} from "@/lib/visit-suggestions";
import { isAdmin } from "@/lib/roles";
import { Icon } from "./Icon";
import { ELASTIC_LABEL, PHASE_LABEL, type ElasticClass, type OrthoPhase } from "@/lib/ortho";
import { ServiceSelect } from "./ServiceSelect";
import { VisitMaterials } from "./VisitMaterials";
import { QuickServicePicker } from "./QuickServicePicker";
import { patientRecordFocusKey, type PatientVisitWorkFocus } from "@/lib/patient-workspace-focus";
import { readVisitWorkSnapshot, resolveVisitWork, VISIT_WORK_FAILURE, type VisitWorkProcedure, type VisitWorkResolution } from "@/lib/patient-visit-work";
import { ENDO_STAGE_LABEL } from "@/lib/endodontics";
import { readStructuredClinical, unavailableStructuredClinical, type VisitStructuredClinical } from "@/lib/visit-structured-clinical";

const orthoPhaseLabel = (phase: string): string =>
  PHASE_LABEL[phase as OrthoPhase] ?? phase;

/**
 * «آخر شدّ قبل ٠ يومًا» جملةٌ لا يقولها إنسان.
 *
 * والطبيب يقرأ هذا السطر عشرات المرّات في اليوم، فركاكته تُقرأ في كل مرة.
 */
function sinceText(days: number | null): string {
  if (days === null) return "لا شدّات مسجّلة بعد";
  if (days <= 0) return "آخر شدّ اليوم";
  if (days === 1) return "آخر شدّ أمس";
  if (days === 2) return "آخر شدّ قبل يومين";
  if (days <= 10) return `آخر شدّ قبل ${days} أيام`;
  return `آخر شدّ قبل ${days} يومًا`;
}

/**
 * الزيارة السريرية — مساحة عمل الطبيب، والحلقة التي تُغلق الرحلة (المواصفة §١٢-٢٢).
 *
 * الطبيب يرى «مخطَّط لليوم» من بنود الخطة بأسعارها وفق قواعد الفوترة — فلا يُعاد
 * إدخال السعر ولا يُخمَّن. و«مراجعة وإنهاء الزيارة» تُظهر ما نُفّذ وما لم يُنفَّذ
 * والاستحقاق الناتج والجلسة القادمة قبل التأكيد — والتوقيع هو الذي يولّد كل شيء
 * في معاملةٍ واحدة: الفاتورة وتقدّم الجلسات والمخطط والزيارة المخطَّطة التالية.
 */

interface Service {
  id: number; name: string; category: string | null; priceMinor: number; priceConfigured?: boolean;
  /** (DAY1) السعر الذي تُسعَّر به في زيارةٍ بكل عملة — من الخادم (الخاص أو المحوَّل بسعر الصرف). */
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}

/**
 * (DAY1) سعر الدليل بعملة الزيارة كما يقرّه الخادم: اليمني من الدليل، والسعودي/الدولار
 * سعرها الخاص أو المحوَّل. `configured` = هل يُطلب سببٌ لو اختلف السعر المكتوب.
 */
function catalogFor(service: Service, currency: Currency): { minor: number | null; configured: boolean } {
  if (currency === CLINIC_BASE_CURRENCY) {
    return { minor: service.priceMinor, configured: service.priceConfigured !== false && service.priceMinor > 0 };
  }
  const priced = service.priceIn?.[currency];
  if (!priced || priced.minor === null) return { minor: null, configured: false };
  return {
    minor: priced.minor,
    configured: priced.minor > 0 && (priced.source === "catalog" || service.priceConfigured !== false),
  };
}

const CURRENCY_CHOICES: { value: Currency; label: string }[] = [
  { value: "YER", label: "ريال يمني" },
  { value: "SAR", label: "ريال سعودي" },
  { value: "USD", label: "دولار" },
];
interface Doctor { id: number; name: string }
interface Visit {
  id: number; patientId: number | null; patientName: string;
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; addendum: string | null;
  doctorId: number | null; status: "open" | "signed";
  signedAt: string | null; signedBy: string | null; invoiceId: number | null;
  structuredClinical?: VisitStructuredClinical;
  procedures: VisitWorkProcedure[]; totalMinor: number;
  planItemsMatched: number; planTitle: string | null; planWarning: string | null;
  ortho: {
    caseId: number; appliance: string; phase: string; slot: string;
    upperWire: string | null; lowerWire: string | null;
    lastAdjustment: string | null; daysSinceLast: number | null;
    lastDone: string | null; elastics: string | null; elasticNote: string | null;
    suggestedUpper: string | null; suggestedLower: string | null;
    /** (CASE-1) شدّة هذه الزيارة إن سُجّلت — فلا تُرسل مرةً ثانية. */
    visitAdjustmentId: number | null; legacyBaseline: boolean; nextWeeks: number;
    adjustmentBillingClass: "INCLUDED" | "LEGACY_INCLUDED" | "NEW_BILLABLE" | "OUTSIDE_CONTRACT" | "NO_CHARGE";
  } | null;
  plannedVisit: {
    id: number; title: string; sequence: number;
    planTitle: string | null; doctorId: number | null; durationMinutes: number;
  } | null;
  previousVisit: {
    id: number; date: string; treatmentDone: string | null;
    nextPlan: string | null; proceduresSummary: string | null;
    diagnosis?: string | null;
  } | null;
  /** (P0-E) آخر تشخيص موثَّق والحالات الجارية بخطوتها التالية — سياقٌ لا يبدأ فارغًا. */
  latestDiagnosis?: { text: string; date: string } | null;
  activeCases?: {
    id: number | null; kind: "specialty" | "ortho"; title: string; specialty: string; status: string;
    responsibleName: string | null; doneSteps: number; totalSteps: number; nextStep: string | null;
  }[];
  outstanding: {
    planItemId: number; serviceId: number | null; planTitle: string; serviceName: string;
    toothCode: number | null; billingRule: BillingRule;
    sessionCount: number; doneSessions: number; unitPriceMinor: number;
    quantity: number; status: string;
    /* (المراجعة النهائية للمالك — TD-05) عملة اتفاق خطة هذا البند بعينه:
       السعر المقترح لحظة إضافته يُنسَّق بها — زيارةٌ فارغة بلا إجراءاتٍ
       مرتبطة لا تعرف عملتها أصلًا، فلا يُستنتج من عملة الزيارة شيء. */
    planCurrency: Currency;
    /** (BILL-1) جلساته مشمولة في اتفاق أقساط خطته — صفرٌ ولا فاتورة. */
    includedByAgreement?: boolean;
    /** (CASE-MODEL-1b) ما يتطلبه البند ولم يتحقق بعد. */
    unmetRequirements?: string[];
  }[];
  /* (TD-05 owner review) عملة بنود الخطة المرتبطة — واحدةً تعاين بها الأرقام. */
  planCurrency?: Currency | null;
  /** (DAY1) عملة الزيارة للإجراءات الحرّة كما اختارها الطاقم — null: الأساس. */
  billingCurrency?: Currency | null;
  sessionPricing: {
    planItemId: number; procedureId: VisitWorkProcedure["id"];
    sessionIndex: number; sessionCount: number;
    priceMinor: number; note: string;
  }[];
  /** طلبات المختبر المرتبطة بالزيارة؛ لا تثبت نسبتها إلى إجراء بعينه. */
  labOrders: {
    id: number; workType: string; toothCode: number | null;
    status: string; labName: string;
  }[];
  /** (VISIT-1) اقتراحات الخادم لملء الفارغ من الحقول. */
  suggestions?: VisitSuggestions;
  /** (REF-3) الإحالة الداخلية التي جاءت بها الزيارة — لافتة «محال من د. …». */
  referral?: {
    id: number; fromName: string | null; reason: string; teeth: string | null;
    caseTitle: string | null; blocksCaseTitle: string | null; workflowState: string;
  } | null;
}

type NoteKey = "chiefComplaint" | "examination" | "diagnosis" | "treatmentDone" | "nextPlan";

/** نتيجة التوقيع — ما يحتاجه الشبّاك والملخص بعد الإنهاء. */
export interface VisitSignResult {
  invoiceId: number | null;
  /* (TD-05 owner review — Finding 1) عملة فاتورة الزيارة الفعلية — الشبّاك
     يعرض استحقاق اليوم بها، والتحصيل يستهدف فاتورتها بها. */
  invoiceCurrency: Currency | null;
  duesMinor: number;
  sessionsCompleted: number;
  nextPlannedVisit: { id: number; title: string; sequence: number; durationMinutes: number; suggestedDate?: string | null; afterDays?: number | null } | null;
  /** طلبات مختبر تولّدت تلقائيًا من إجراءات المعمل (§١٩). */
  labOrdersCreated?: number;
  /** حركات مستهلكات خُصمت تلقائيًا (§٢٠). */
  materialsDeducted?: number;
  /** (VISIT-2) ملف المريض بعد التوقيع — يُنشأ للمريض المشي إن لم يكن له ملف. */
  patientId?: number | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
// Only these two wire fields are BIGSERIAL: procedures.id and its copied
// sessionPricing.procedureId. No Number conversion, including above 2^53 - 1.
const procedureRecordId = (value: unknown): value is VisitWorkProcedure["id"] => positiveId(value)
  || (typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807"));
const nullableId = (value: unknown) => value === null || positiveId(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const rows = (value: unknown, valid: (row: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((row) => record(row) && valid(row));

/** Validate before adopting a read. A cast/HTTP 200 is not a canonical snapshot. */
export function isClinicalVisitPayload(value: unknown, visitId: number, patientId?: number | null): value is Visit {
  if (!record(value) || value.id !== visitId || !nullableId(value.patientId)
    || (patientId !== undefined && value.patientId !== patientId)
    || typeof value.patientName !== "string" || !nullableId(value.doctorId) || !nullableId(value.invoiceId)
    || (value.status !== "open" && value.status !== "signed")
    || !["chiefComplaint", "examination", "diagnosis", "treatmentDone", "nextPlan", "addendum", "signedAt", "signedBy", "planTitle", "planWarning"].every((key) => nullableText(value[key]))
    || (value.status === "signed" && (typeof value.signedAt !== "string" || !value.signedAt))
    || !count(value.totalMinor) || !count(value.planItemsMatched)
    || (value.billingCurrency != null && !isCurrency(value.billingCurrency))) return false;
  if (!rows(value.procedures, (line) => procedureRecordId(line.id) && positiveId(line.serviceId)
    && typeof line.serviceName === "string" && nullableText(line.category) && nullableId(line.toothCode)
    && nullableText(line.surfaces) && positiveId(line.quantity) && count(line.unitPriceMinor)
    && nullableId(line.doctorId) && nullableId(line.planItemId)
    && (line.planItemId === null ? (line.planCurrency == null || isCurrency(line.planCurrency)) : isCurrency(line.planCurrency)))) return false;
  if (!rows(value.outstanding, (item) => positiveId(item.planItemId) && nullableId(item.serviceId)
    && typeof item.planTitle === "string" && typeof item.serviceName === "string" && nullableId(item.toothCode)
    && (isBillingRule(item.billingRule) || item.billingRule === "package") && positiveId(item.sessionCount) && count(item.doneSessions)
    && count(item.unitPriceMinor) && positiveId(item.quantity) && typeof item.status === "string"
    && isCurrency(item.planCurrency) && (item.includedByAgreement === undefined || typeof item.includedByAgreement === "boolean")
    && (item.unmetRequirements === undefined
      || (Array.isArray(item.unmetRequirements) && item.unmetRequirements.every((line) => typeof line === "string"))))) return false;
  if (!rows(value.sessionPricing, (item) => positiveId(item.planItemId) && procedureRecordId(item.procedureId)
    && positiveId(item.sessionIndex) && positiveId(item.sessionCount) && count(item.priceMinor) && typeof item.note === "string")
    || !rows(value.labOrders, (item) => positiveId(item.id) && typeof item.workType === "string"
      && nullableId(item.toothCode) && typeof item.status === "string" && typeof item.labName === "string")) return false;
  if (value.plannedVisit !== null && (!record(value.plannedVisit) || !positiveId(value.plannedVisit.id)
    || typeof value.plannedVisit.title !== "string" || !positiveId(value.plannedVisit.sequence)
    || !nullableText(value.plannedVisit.planTitle) || !nullableId(value.plannedVisit.doctorId)
    || !count(value.plannedVisit.durationMinutes))) return false;
  if (value.previousVisit !== null && (!record(value.previousVisit) || !positiveId(value.previousVisit.id)
    || typeof value.previousVisit.date !== "string" || !["treatmentDone", "nextPlan", "proceduresSummary"].every((key) => nullableText((value.previousVisit as Record<string, unknown>)[key])))) return false;
  if (value.ortho !== null && (!record(value.ortho) || !positiveId(value.ortho.caseId)
    || !["appliance", "phase", "slot", "adjustmentBillingClass"].every((key) => typeof (value.ortho as Record<string, unknown>)[key] === "string")
    || !["upperWire", "lowerWire", "lastAdjustment", "lastDone", "elastics", "elasticNote", "suggestedUpper", "suggestedLower"].every((key) => nullableText((value.ortho as Record<string, unknown>)[key]))
    || !nullableId(value.ortho.visitAdjustmentId) || !count(value.ortho.nextWeeks)
    // caseProgress uses a signed day difference, including accepted future dates.
    || !(value.ortho.daysSinceLast === null || (typeof value.ortho.daysSinceLast === "number"
      && Number.isSafeInteger(value.ortho.daysSinceLast))))) return false;
  if (value.suggestions !== undefined && (!record(value.suggestions)
    || !["chiefComplaint", "nextPlan"].every((key) => value.suggestions && nullableText((value.suggestions as Record<string, unknown>)[key]))
    || !nullableId(value.suggestions.doctorId))) return false;
  if (value.latestDiagnosis != null && (!record(value.latestDiagnosis) || typeof value.latestDiagnosis.text !== "string" || typeof value.latestDiagnosis.date !== "string")) return false;
  if (value.activeCases !== undefined && !rows(value.activeCases, (item) => nullableId(item.id)
    && ["kind", "title", "specialty", "status"].every((key) => typeof item[key] === "string")
    && nullableText(item.responsibleName) && count(item.doneSteps) && count(item.totalSteps) && nullableText(item.nextStep))) return false;
  if (value.referral != null && (!record(value.referral) || !positiveId(value.referral.id)
    || !["fromName", "teeth", "caseTitle", "blocksCaseTitle"].every((key) => nullableText((value.referral as Record<string, unknown>)[key]))
    || typeof value.referral.reason !== "string" || typeof value.referral.workflowState !== "string")) return false;
  return true;
}

/** The signed POST carries operation results which GET cannot reconstruct. */
function signedResult(value: unknown, visitId: number, patientId: number | null): VisitSignResult | null {
  if (!record(value) || value.id !== visitId || value.patientId !== patientId || !positiveId(patientId)
    || value.status !== "signed" || typeof value.signedAt !== "string" || !value.signedAt
    || !nullableId(value.invoiceId) || !(value.invoiceCurrency === null || isCurrency(value.invoiceCurrency))
    || !count(value.duesMinor) || !count(value.sessionsCompleted)
    || (value.invoiceId !== null && !isCurrency(value.invoiceCurrency))
    || (value.duesMinor > 0 && (value.invoiceId === null || !isCurrency(value.invoiceCurrency)))
    || (value.labOrdersCreated !== undefined && !count(value.labOrdersCreated))
    || (value.materialsDeducted !== undefined && !count(value.materialsDeducted))) return null;
  const next = value.nextPlannedVisit;
  if (next !== null && (!record(next) || !positiveId(next.id) || typeof next.title !== "string"
    || !positiveId(next.sequence) || !count(next.durationMinutes)
    || (next.suggestedDate !== undefined && !nullableText(next.suggestedDate))
    || (next.afterDays != null && !count(next.afterDays)))) return null;
  return {
    invoiceId: value.invoiceId as number | null, invoiceCurrency: value.invoiceCurrency as Currency | null,
    duesMinor: value.duesMinor, sessionsCompleted: value.sessionsCompleted,
    nextPlannedVisit: next as VisitSignResult["nextPlannedVisit"], patientId,
    ...(value.labOrdersCreated === undefined ? {} : { labOrdersCreated: value.labOrdersCreated as number }),
    ...(value.materialsDeducted === undefined ? {} : { materialsDeducted: value.materialsDeducted as number }),
  };
}

type AcceptedRead = { status: "accepted"; visit: Visit; sequence: number };
type ReadResult = AcceptedRead | { status: "unavailable"; ownerChanged?: true } | { status: "superseded" };
type WriteHold = {
  generation: number;
  kind: "unknown" | "refresh-needed" | "signed";
  action: "save" | "addendum" | "sign";
  patientId: number | null;
  observed?: AcceptedRead;
  requiresSigned?: boolean;
};
const definitiveRejection = (status: number) => [400, 401, 403, 404, 409, 413, 422, 429].includes(status);
const UNKNOWN_WRITE = "نتيجة الطلب غير مؤكدة؛ قد يكون سُجّل بالفعل. لا تُعد الحفظ أو التوقيع. احتفظ بالمسودة وراجع السجل مع المسؤول قبل أي طلب جديد.";
const SAVED_REFRESH_FAILED = "تم قبول الحفظ، لكن تعذّر تحديث الزيارة. المسودة محفوظة هنا؛ حدّث السجل للقراءة ثم راجعه واعتمده صراحةً قبل المتابعة.";
const SIGNED_REFRESH_FAILED = "تم التوقيع وتأكدت نتيجته المالية، لكن تعذّر تحديث العرض. لا تُعد التوقيع؛ حدّث السجل للقراءة.";

interface Draft {
  /** Display-only eligibility: saved category or an explicitly picked catalog service. Never submitted. */
  labCategory: string | null;
  serviceId: number; toothCode: string; surfaces: string; quantity: number;
  price: string; doctorId: number | null; planItemId: number | null;
  /** (P1-6) سبب الانحراف عن سعر الدليل — يُطلب ويُرسل حين يختلف السعر. */
  priceReason?: string;
  /* (المراجعة النهائية للمالك — TD-05) العملة ملك السطر نفسه: مرتبطٌ ببند
     خطة ⇒ عملة خطة ذلك البند (من الحمولة، لكل سطرٍ على حدة)؛ حرٌّ ⇒ الأساس.
     كل قراءةٍ وكتابةٍ وعرضٍ ومجموعٍ للسطر يجري بها — لا استنتاجٌ من حالة
     الزيارة ولا من حالة React لم تُثبَّت بعد. */
  currency: Currency;
}

/** (P6) معاينة الاستحقاق كما يعيدها `GET /api/visits/[id]/billing-preview`. */
interface BillingPreview {
  duesByCurrency: Partial<Record<Currency, number>>;
  mixedCurrencies: boolean;
  zeroReason: string | null;
}

export function ClinicalVisit({ visitId, expectedLinkedPatientId, onSigned, autoReview = false, structuredRefreshKey = 0, workFocus = null, suspended = false, onNavigationGuardChange }: {
  visitId: number;
  /** Parent patient-file intent; it narrows reads/saves and never grants access. */
  expectedLinkedPatientId?: number;
  workFocus?: PatientVisitWorkFocus | null;
  /** Retains an already mounted draft when its current-visit identity is retired. */
  suspended?: boolean;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
  onSigned?: (result: VisitSignResult) => void;
  /** (VISIT-2) افتح «مراجعة وإنهاء الزيارة» مباشرةً بعد التحميل — حين يصل الطبيب إلى ملف
   *  المريض الجديد الذي فُتح له للتوّ من زيارته ليكمل الإنهاء هناك. */
  autoReview?: boolean;
  /** Advance after a confirmed specialty save; refreshes saved references only. */
  structuredRefreshKey?: number | string;
}) {
  // (TD-05) الأساس دستوري من الكود.
  const base: Currency = CLINIC_BASE_CURRENCY;
  const session = useSession();
  /* (P0-F) المساعد السريري يُكمل الملاحظات ويُنهي الزيارة باسمه؛ الإجراءات وأسعارها والطبيب المعالج
     للطبيب والمدير وحدهما — والخادم يرفض غير ذلك صراحةً. */
  const canWrite = isAdmin(session?.role) || session?.role === "doctor" || session?.role === "assistant";
  const canEditWork = isAdmin(session?.role) || session?.role === "doctor";

  const [visit, setVisit] = useState<Visit | null>(null);
  const [loadedGeneration, setLoadedGeneration] = useState<number | null>(null);
  /* (TD-05 owner review — Finding 1) عملة فاتورة هذه الزيارة كما سيوقّعها
   * الخادم: عملة بنود خطتها إن كانت بعملةٍ واحدة، وإلا الأساس. أرقام المعاينة
   * قبل التوقيع تُعرض بها — لا بعملة الدفاتر.
   *
   * (المراجعة النهائية للمالك — TD-05) هذه **ملخصٌ للعرض فقط**؛ أما عملة كل
   * سطرٍ فملكه هو: `Draft.currency` من بند خطته، سطرًا سطرًا — انظر load()
   * وaddPlannedItem() أدناه. زيارةٌ بأسطرٍ من خططٍ بعملاتٍ مختلفة تعرض
   * كل سطرٍ بعملته، والتوقيع المختلط يظل مرفوضًا من الخادم كما هو. */
  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  /** (DAY1) عملة الزيارة — الإجراءات الحرّة تُسعَّر وتُفوتر بها. */
  const [visitCurrency, setVisitCurrency] = useState<Currency>(CLINIC_BASE_CURRENCY);
  const [notes, setNotes] = useState({
    chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "",
  });
  const [doctorId, setDoctorId] = useState<number | null>(null);
  /* (CASE-1) شدّة التقويم في هذه الزيارة — تُرسل مع التوقيع وتُكتب في معاملته، مرةً واحدة. */
  const [orthoSession, setOrthoSession] = useState<{
    upperWire: string; lowerWire: string; elastics: ElasticClass; elasticNote: string; done: string; nextWeeks: string;
  } | null>(null);
  /* (VISIT-1) ما مُلئ تلقائيًا — يُوسَم «تلقائي» حتى يلمسه الطبيب. */
  const [autoFilled, setAutoFilled] = useState<Set<NoteKey | "doctor">>(new Set());
  /* آخر نصٍّ ولّدته الإجراءات في «ما نُفّذ» — ما دام الحقل عليه (أو فارغًا) يتبع الإجراءات. */
  const lastAutoTreatment = useRef("");
  const phrases = {
    chiefComplaint: parsePhraseList(useSetting("clinical.phrases_complaint")),
    examination: parsePhraseList(useSetting("clinical.phrases_exam")),
    diagnosis: parsePhraseList(useSetting("clinical.phrases_diagnosis")),
    nextPlan: parsePhraseList(useSetting("clinical.phrases_next")),
  };
  const [addendum, setAddendum] = useState("");
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const setBusy = useCallback((value: boolean) => { busyRef.current = value; setBusyState(value); }, []);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [writeHoldState, setWriteHoldState] = useState<WriteHold | null>(null);
  const writeHoldRef = useRef<WriteHold | null>(null);
  const setWriteHold = useCallback((value: Omit<WriteHold, "generation"> | null) => {
    const next = value ? { ...value, generation: scopeRecord.current.generation } : null;
    writeHoldRef.current = next; setWriteHoldState(next);
  }, []);
  const operationRef = useRef<object | null>(null);
  const interactionVersion = useRef(0);
  const interaction = interactionVersion.current;
  const signedReceipt = useRef<VisitSignResult | null>(null);
  const pendingAttempt = useRef<{ generation: number; action: WriteHold["action"]; patientId: number | null } | null>(null);
  const [readDenied, setReadDenied] = useState(false);
  const readDeniedRef = useRef(false);
  const [structuredRetry, setStructuredRetry] = useState(0);
  const structuredKey = JSON.stringify([visitId, expectedLinkedPatientId, structuredRefreshKey, structuredRetry, reviewOpen,
    session?.username, session?.role, session?.permissions]);
  const structuredKeyRef = useRef(structuredKey);
  structuredKeyRef.current = structuredKey;
  const [structuredRead, setStructuredRead] = useState<{ key: string; value: VisitStructuredClinical } | null>(null);
  const structuredClinical = structuredRead?.key === structuredKey && visit?.id === visitId
    && structuredRead.value.patientId === visit.patientId ? structuredRead.value : null;
  // A review/token refresh cannot call load(): it would replace unsaved canonical
  // notes and procedures. Late responses stay bound to their original scope.
  useEffect(() => {
    const patientId = visit?.patientId;
    if (visit?.id !== visitId || !patientId || structuredRead?.key === structuredKey
      || (expectedLinkedPatientId !== undefined && patientId !== expectedLinkedPatientId)) return;
    let cancelled = false;
    void (async () => {
      let value = unavailableStructuredClinical(visitId, patientId);
      try {
        const response = await fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" });
        const payload = await response.json();
        if (response.ok && payload?.id === visitId && payload?.patientId === patientId) {
          value = readStructuredClinical(payload.structuredClinical, visitId, patientId);
        }
      } catch { /* Unavailable remains explicit; never replace it with empty. */ }
      if (!cancelled) setStructuredRead({ key: structuredKey, value });
    })();
    return () => { cancelled = true; };
  }, [visitId, expectedLinkedPatientId, visit?.id, visit?.patientId, structuredKey, structuredRead?.key]);
  /* (P3) منتقي الدليل السريع لإضافة إجراءٍ حرّ — نفس مسار الإضافة من القائمة. */
  const [pickerOpen, setPickerOpen] = useState(false);
  /* (P6) استحقاق الزيارة من الخادم بقرار التوقيع نفسه — يُقرأ عند فتح المراجعة (بعد الحفظ). */
  const [billingPreview, setBillingPreview] = useState<BillingPreview | null>(null);
  /* (CASE-MODEL-1b) سبب المتابعة رغم متطلبٍ لم يكتمل — يُرسَل مع التوقيع ويُدقَّق. */
  const [overrideReason, setOverrideReason] = useState("");
  /* (P1-C) قرار الشدّة خارج العقد عند التوقيع: «بلا رسوم» بسببٍ مكتوب — وإلا تبقى معلّقة للمتابعة. */
  const [noChargeAdjustment, setNoChargeAdjustment] = useState(false);
  const [noChargeReason, setNoChargeReason] = useState("");
  const [serverUnmet, setServerUnmet] = useState<string[]>([]);
  const autoReviewDone = useRef(false);
  useEffect(() => {
    if (!reviewOpen) { setBillingPreview(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/visits/${visitId}/billing-preview`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        setBillingPreview(await response.json() as BillingPreview);
      } catch {
        // بلا معاينة تبقى المراجعة كما كانت — والتوقيع يقرر في الخادم على أي حال.
      }
    })();
    return () => { cancelled = true; };
  }, [reviewOpen, visitId]);
  /* الوصفة الطبية من مساحة العمل (من عمل الوكيل المساعد): التشخيص والطبيب
     يُعبّآن تلقائيًا مما كُتب في الزيارة — الطبيب يكتب التشخيص مرة واحدة. */
  const [rxOpen, setRxOpen] = useState(false);
  const [postOpOpen, setPostOpOpen] = useState(false);
  /* سياق مريض الزيارة: التنبيه الطبي والهاتف — ليعمل فحص أمان الدواء داخل
     نافذة الوصفة على بيانات المريض لا على فراغ (P0.10). */
  const [patientContext, setPatientContext] = useState<{
    medicalAlert: string | null; phone: string | null;
  } | null>(null);

  useEffect(() => {
    const patientId = visit?.patientId;
    if (!patientId) {
      setPatientContext(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/patients/${patientId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { medicalAlert?: string | null; phone?: string | null } | null) => {
        if (!cancelled && data) {
          setPatientContext({ medicalAlert: data.medicalAlert ?? null, phone: data.phone ?? null });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visit?.patientId]);

  const loadSequence = useRef(0);
  const mountedRef = useRef(true);
  const scope = JSON.stringify([visitId, expectedLinkedPatientId, session?.username, session?.role, session?.permissions]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeRecord = useRef({ key: scope, generation: 0 });
  if (scopeRecord.current.key !== scope) scopeRecord.current = { key: scope, generation: scopeRecord.current.generation + 1 };
  const scopeGeneration = scopeRecord.current.generation;
  const writeHold = writeHoldState?.generation === scopeGeneration ? writeHoldState : null;
  const draftBaseline = useRef<string | null>(null);
  const baselinePending = useRef(false);
  // Retirement has its own epoch: returning from suspension must not revive
  // a response dispatched before retirement, even under the same visit ID.
  const ownerEpoch = useRef(0);
  const suspension = useRef(suspended);
  if (suspension.current !== suspended) {
    suspension.current = suspended; ownerEpoch.current += 1;
    const pending = pendingAttempt.current;
    if (suspended && pending?.generation === scopeGeneration && !writeHoldRef.current) {
      setWriteHold({ kind: "unknown", action: pending.action, patientId: pending.patientId });
      setReviewOpen(false);
    }
  }
  const epoch = ownerEpoch.current;
  const currentOwner = useCallback(() => mountedRef.current && !suspendedRef.current
    && scope === scopeRef.current && scopeGeneration === scopeRecord.current.generation
    && epoch === ownerEpoch.current, [scope, scopeGeneration, epoch]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; loadSequence.current += 1; };
  }, []);
  const loadedOwner = useRef<{ generation: number; patientId: number | null } | null>(null);
  const applyRead = useCallback((loaded: Visit, keyAtRead = structuredKeyRef.current) => {
    loadedOwner.current = { generation: scopeGeneration, patientId: loaded.patientId };
    readDeniedRef.current = false; setReadDenied(false);
    baselinePending.current = true;
    setVisit(loaded);
    setLoadedGeneration(scopeGeneration);
    setStructuredRead({ key: keyAtRead, value: loaded.patientId === null
      ? unavailableStructuredClinical(visitId, null)
      : readStructuredClinical(loaded.structuredClinical, visitId, loaded.patientId) });
    /* (VISIT-1) الفارغ فقط يُملأ من الاقتراحات، وفي الزيارة المفتوحة فقط — ولا يُحفظ
       شيءٌ منه حتى يحفظ الطبيب أو يوقّع. */
    const open = loaded.status === "open";
    const suggested = open ? loaded.suggestions : undefined;
    const filled = new Set<NoteKey | "doctor">();
    const pick = (key: NoteKey, saved: string | null, suggestion: string | null | undefined) => {
      if (saved) return saved;
      if (suggestion) { filled.add(key); return suggestion; }
      return "";
    };
    setNotes({
      chiefComplaint: pick("chiefComplaint", loaded.chiefComplaint, suggested?.chiefComplaint),
      examination: loaded.examination ?? "",
      diagnosis: loaded.diagnosis ?? "", treatmentDone: loaded.treatmentDone ?? "",
      nextPlan: pick("nextPlan", loaded.nextPlan, suggested?.nextPlan),
    });
    if (!loaded.doctorId && suggested?.doctorId) filled.add("doctor");
    setDoctorId(loaded.doctorId ?? suggested?.doctorId ?? null);
    setAutoFilled(filled);
    const loadedCurrency: Currency = isCurrency(loaded.billingCurrency) ? loaded.billingCurrency : CLINIC_BASE_CURRENCY;
    setVisitCurrency(loadedCurrency);
    /* (المراجعة النهائية للمالك — TD-05) العملة ملك البند لا الزيارة:
     * كل سطرٍ يُشتق عملته من **بند خطته هو** في الحمولة المحمّلة نفسها
     * (`procedures[].planCurrency`) — لا من عملةٍ واحدة على مستوى الزيارة
     * ولا من حالة React لم تُثبّت بعد. السطر المرتبط بخطةٍ دولارية يُنسَّق
     * «1,500.00» ولو كانت الزيارة فارغةً قبله؛ والسطر المرتبط بخطةٍ أخرى
     * العملة يُنسَّق بعملتها هو؛ والسطر الحر بالأساس. والمزيج يظهر
     * مجموعين منفصلين وتحذيرًا — والتوقيع المختلط يُرفض من الخادم. */
    setDrafts(loaded.procedures.map((line) => {
      const lineCurrency = isCurrency(line.planCurrency)
        ? (line.planCurrency as Currency)
        : loadedCurrency;
      return {
        labCategory: line.category,
        serviceId: line.serviceId, toothCode: line.toothCode ? String(line.toothCode) : "",
        surfaces: line.surfaces ?? "", quantity: line.quantity,
        price: formatAmount(line.unitPriceMinor, lineCurrency),
        doctorId: line.doctorId,
        planItemId: line.planItemId,
        currency: lineCurrency,
      };
    }));
  }, [visitId, scopeGeneration]);
  const load = useCallback(async (options?: { observeOnly?: boolean; patientId?: number | null }): Promise<ReadResult> => {
    if (!currentOwner()) return { status: "superseded" };
    const sequence = ++loadSequence.current;
    const keyAtRead = structuredKeyRef.current;
    const expectedPatientId = options?.patientId !== undefined ? options.patientId : (loadedOwner.current?.generation === scopeGeneration
      ? loadedOwner.current.patientId : expectedLinkedPatientId);
    const active = () => currentOwner() && sequence === loadSequence.current;
    try {
      const visitResponse = await fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" });
      if (!active()) return { status: "superseded" };
      if ([401, 403, 404].includes(visitResponse.status)) {
        // Keep the held submission in this owner, but redact denied clinical UI.
        readDeniedRef.current = true; setReadDenied(true); setReviewOpen(false);
      }
      const payload: unknown = await visitResponse.json();
      if (!active()) return { status: "superseded" };
      if (!visitResponse.ok) throw new Error(record(payload) && typeof payload.message === "string" ? payload.message : "تعذّر التحميل.");
      // Parent intent is independent of the captured read/recovery expectation.
      // A later read must never rebind an existing draft to another linked owner.
      if (record(payload) && ((expectedLinkedPatientId !== undefined
        && (!positiveId(expectedLinkedPatientId) || payload.patientId !== expectedLinkedPatientId))
        || (positiveId(payload.id) && payload.id !== visitId)
        || (expectedPatientId !== undefined && nullableId(payload.patientId) && payload.patientId !== expectedPatientId))) {
        setError("تغيّرت هوية الزيارة أو مريضها في القراءة. لم تُستبدل المسودة.");
        return { status: "unavailable", ownerChanged: true };
      }
      if (!isClinicalVisitPayload(payload, visitId, expectedPatientId)) throw new Error("تعذّر التحقق من بيانات الزيارة ومريضها. لم تُستبدل المسودة.");
      const [serviceResponse, partyResponse] = await Promise.all([
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      const servicePayload: unknown = serviceResponse.ok ? await serviceResponse.json() : null;
      const partyPayload: unknown = partyResponse.ok ? await partyResponse.json() : null;
      if (!active()) return { status: "superseded" };
      const parties = record(partyPayload) ? partyPayload.balances : partyPayload;
      if (servicePayload !== null && !rows(servicePayload, (row) => positiveId(row.id)
        && typeof row.name === "string" && nullableText(row.category) && count(row.priceMinor))) throw new Error("تعذّر التحقق من دليل الخدمات.");
      if (parties !== null && !rows(parties, (row) => positiveId(row.id) && typeof row.name === "string")) throw new Error("تعذّر التحقق من قائمة الأطباء.");
      if (!options?.observeOnly) {
        if (writeHoldRef.current) return { status: "superseded" };
        applyRead(payload, keyAtRead);
      }
      if (servicePayload !== null) setServices(servicePayload as Service[]);
      if (parties !== null) setDoctors(parties as Doctor[]);
      readDeniedRef.current = false; setReadDenied(false);
      setError(null);
      return { status: "accepted", visit: payload, sequence };
    } catch (loadError) {
      if (!active()) return { status: "superseded" };
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
      return { status: "unavailable" };
    }
  }, [visitId, expectedLinkedPatientId, scopeGeneration, currentOwner, applyRead]);

  useEffect(() => {
    operationRef.current = null; pendingAttempt.current = null;
    interactionVersion.current += 1;
    setBusy(false); setWriteHold(null); signedReceipt.current = null;
    readDeniedRef.current = false; setReadDenied(false);
    draftBaseline.current = null; baselinePending.current = false;
    setReviewOpen(false); setPickerOpen(false); setRxOpen(false); setPostOpOpen(false);
    setBillingPreview(null); setOrthoSession(null); setAddendum("");
    setOverrideReason(""); setNoChargeAdjustment(false); setNoChargeReason(""); setServerUnmet([]);
    autoReviewDone.current = false; lastAutoTreatment.current = "";
    return () => { loadSequence.current += 1; };
  }, [scope, scopeGeneration, setBusy, setWriteHold]);
  useEffect(() => {
    // Resume a retired initial read, but never overwrite a retained dirty draft.
    if (currentOwner() && loadedOwner.current?.generation !== scopeGeneration && !writeHoldRef.current) void load();
  }, [currentOwner, scopeGeneration, load]);

  /* (VISIT-1) «ما نُفّذ» يُكتب من الإجراءات المضافة — ويتبعها ما دام الطبيب لم يكتب فيه بنفسه. */
  const visitOpen = visit?.status === "open";
  useEffect(() => {
    if (!visitOpen || writeHoldRef.current || readDeniedRef.current || suspendedRef.current) return;
    const text = treatmentDoneFromProcedures(drafts.map((draft) => ({
      name: services.find((service) => service.id === draft.serviceId)?.name
        ?? visit?.outstanding.find((item) => item.planItemId === draft.planItemId)?.serviceName
        ?? "",
      toothCode: draft.toothCode, quantity: draft.quantity,
    })));
    const previous = lastAutoTreatment.current;
    lastAutoTreatment.current = text;
    setNotes((current) => (current.treatmentDone.trim() === "" || current.treatmentDone === previous)
      ? { ...current, treatmentDone: text } : current);
  }, [drafts, services, visitOpen, visit?.outstanding]);

  const localDraftKey = JSON.stringify([notes, drafts, doctorId, visitCurrency, orthoSession, addendum]);
  const currentDraftKey = useRef(localDraftKey);
  currentDraftKey.current = localDraftKey;
  useEffect(() => {
    if (baselinePending.current) { draftBaseline.current = localDraftKey; baselinePending.current = false; }
  }, [localDraftKey, visit]);
  const canLeave = useCallback(() => {
    if (busyRef.current) return false;
    if (writeHoldRef.current) return window.confirm("هناك طلب محفوظ لم يُحدّث عرضه أو طلب غير مؤكّد. المغادرة تفقد حماية هذه الشاشة ومسودتها؛ راجع السجل قبل إعادة أي طلب. هل تريد المغادرة؟");
    return draftBaseline.current === null || draftBaseline.current === currentDraftKey.current
      || window.confirm("هناك عمل غير محفوظ في الزيارة. إذا تغيّرت الزيارة ستُستبدل مسودتها؛ هل تريد الانتقال دون حفظ؟");
  }, []);
  useEffect(() => { onNavigationGuardChange?.(canLeave); return () => onNavigationGuardChange?.(null); }, [canLeave, onNavigationGuardChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (busyRef.current || writeHoldRef.current || (draftBaseline.current !== null && draftBaseline.current !== currentDraftKey.current)) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const [workRetry, setWorkRetry] = useState(0);
  const workKey = JSON.stringify([scope, patientRecordFocusKey(workFocus), workRetry, structuredRefreshKey]);
  const workKeyRef = useRef(workKey);
  workKeyRef.current = workKey;
  const [workRead, setWorkRead] = useState<{ key: string; result: VisitWorkResolution } | null>(null);
  const workResult = workRead?.key === workKey ? workRead.result : null;
  const workContext = useRef({ visit, drafts, canEditWork, workFocus });
  workContext.current = { visit, drafts, canEditWork, workFocus };
  const focusedProcedure = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!workFocus || !visit || visit.id !== visitId || busyRef.current || writeHoldRef.current || readDeniedRef.current || suspendedRef.current) return;
    let cancelled = false;
    const focusAtRead = workFocus;
    void (async () => {
      let result: VisitWorkResolution = { status: "unavailable", reason: "hidden" };
      try {
        const snapshot = await readVisitWorkSnapshot(focusAtRead);
        const current = workContext.current;
        if (current.visit) result = resolveVisitWork({ focus: focusAtRead, patientId: focusAtRead.patientId,
          visitId, canEditWork: current.canEditWork, snapshot, loadedVisit: current.visit, drafts: current.drafts });
      } catch { /* An incomplete/denied read is never an empty eligible plan. */ }
      if (!cancelled && workKeyRef.current === workKey) setWorkRead({ key: workKey, result });
    })();
    return () => { cancelled = true; };
  }, [workKey, workFocus, visit, visitId, busy]);
  useEffect(() => {
    if (workResult?.status === "ready" && workResult.existing) {
      focusedProcedure.current?.scrollIntoView({ block: "center" });
      focusedProcedure.current?.focus({ preventScroll: true });
    }
  }, [workResult]);

  const canEditOwnedDraft = () => currentOwner() && interaction === interactionVersion.current
    && !busyRef.current && !writeHoldRef.current && !readDeniedRef.current;
  const setNote = (key: NoteKey, value: string) => {
    // A save reloads its submitted snapshot. Do not accept newer edits until
    // both the write and that reload have finished.
    if (!canEditOwnedDraft()) return;
    setNotes((current) => ({ ...current, [key]: value }));
    setAutoFilled((current) => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; });
  };
  const send = useCallback(async (body: Record<string, unknown>): Promise<AcceptedRead | null> => {
    if (busyRef.current || writeHoldRef.current || readDeniedRef.current || !currentOwner()
      || interaction !== interactionVersion.current || !visit || visit.id !== visitId) return null;
    const operation = {}; operationRef.current = operation; ++interactionVersion.current;
    const patientId = visit.patientId;
    const action = body.action === "addendum" ? "addendum" : "save";
    // Bind only a linked draft save to the accepted owner of this submission.
    // The server still authorizes its own current visit before comparing intent.
    const requestBody = action === "save" && positiveId(patientId)
      ? { ...body, expectedLinkedPatientId: patientId } : body;
    pendingAttempt.current = { generation: scopeGeneration, action, patientId };
    const active = () => currentOwner() && operationRef.current === operation;
    const unknown = () => {
      if (!active()) return;
      setWriteHold({ kind: "unknown", action, patientId }); setReviewOpen(false); setError(UNKNOWN_WRITE);
    };
    let acknowledged = false;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
      });
      if (!active()) return null;
      if (!response.ok && !definitiveRejection(response.status)) { unknown(); return null; }
      const payload: unknown = await response.json().catch(() => null);
      if (!active()) return null;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) { readDeniedRef.current = true; setReadDenied(true); setReviewOpen(false); }
        setError(record(payload) && typeof payload.message === "string" ? payload.message : "تعذّر الحفظ.");
        return null;
      }
      if (!isClinicalVisitPayload(payload, visitId, patientId)
        || (action === "addendum" && payload.status !== "signed")) { unknown(); return null; }
      // Acknowledgment is known; display readiness still requires an accepted GET.
      acknowledged = true;
      setWriteHold({ kind: "refresh-needed", action, patientId, requiresSigned: payload.status === "signed" });
      if (payload.status === "signed") setVisit({ ...visit, status: "signed", signedAt: payload.signedAt,
        signedBy: payload.signedBy, invoiceId: payload.invoiceId });
      const refreshed = await load({ observeOnly: true, patientId });
      if (!active()) return null;
      if (refreshed.status !== "accepted" || refreshed.sequence !== loadSequence.current
        || (payload.status === "signed" && refreshed.visit.status !== "signed")) {
        setError(SAVED_REFRESH_FAILED); return null;
      }
      applyRead(refreshed.visit); setWriteHold(null); setError(null);
      if (action === "addendum") setAddendum("");
      return refreshed;
    } catch {
      if (acknowledged) { if (active()) setError(SAVED_REFRESH_FAILED); }
      else unknown();
      return null;
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null; pendingAttempt.current = null;
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [visitId, visit, load, applyRead, setBusy, setWriteHold, currentOwner, interaction, scopeGeneration]);

  const refreshHeldWrite = useCallback(async () => {
    const held = writeHoldRef.current;
    if (!held || busyRef.current || !currentOwner()) return;
    const operation = {}; operationRef.current = operation;
    setBusy(true); setWriteHold({ ...held, observed: undefined });
    const readingHold = writeHoldRef.current;
    try {
      const result = await load({ observeOnly: true, patientId: held.patientId });
      if (!currentOwner() || operationRef.current !== operation || writeHoldRef.current !== readingHold) return;
      if (result.status === "accepted" && result.sequence === loadSequence.current) {
        setWriteHold({ ...held, observed: result });
        setError(held.kind === "unknown" ? UNKNOWN_WRITE : null);
      }
    } finally {
      if (operationRef.current === operation) { operationRef.current = null; if (mountedRef.current) setBusy(false); }
    }
  }, [currentOwner, load, setBusy, setWriteHold]);

  const acceptHeldRead = useCallback(() => {
    const held = writeHoldRef.current;
    if (!currentOwner() || busyRef.current || readDeniedRef.current || held !== writeHold
      || !held?.observed || held.observed.sequence !== loadSequence.current || held.kind === "unknown"
      || (held.requiresSigned && held.observed.visit.status !== "signed")) return;
    if (!window.confirm("اعتماد هذه القراءة يستبدل المسودة المحلية المعروضة. راجع الملاحظات والإجراءات والطبيب والعملة أولًا. لا تثبت القراءة عدم وجود تغييرات متزامنة. هل تعتمدها؟")) return;
    ++interactionVersion.current;
    applyRead(held.observed.visit); setWriteHold(null); setError(null);
    if (held.action === "addendum") setAddendum("");
    // This deliberate review uses the accepted GET; recovery never replays POST.
    if (held.kind === "refresh-needed" && held.action === "save" && held.observed.visit.status === "open"
      && held.observed.visit.patientId !== null) setReviewOpen(true);
  }, [currentOwner, writeHold, applyRead, setWriteHold]);

  /** التوقيع — يستجاب بنتيجة الرحلة كاملة فيمرّرها للشبّاك. */
  const sign = useCallback(async () => {
    if (busyRef.current || writeHoldRef.current || readDeniedRef.current || signedReceipt.current || !currentOwner()
      || interaction !== interactionVersion.current || !visit || visit.status !== "open") return;
    if (structuredClinical?.status !== "ready" || structuredClinical.signedAt !== null) {
      setError("حدّث التوثيق التخصصي المحفوظ وراجعه قبل التوقيع."); return;
    }
    const operation = {}; operationRef.current = operation; ++interactionVersion.current;
    const patientId = visit.patientId;
    pendingAttempt.current = { generation: scopeGeneration, action: "sign", patientId };
    const active = () => currentOwner() && operationRef.current === operation;
    const unknown = () => {
      if (!active() || signedReceipt.current) return;
      setWriteHold({ kind: "unknown", action: "sign", patientId }); setReviewOpen(false); setError(UNKNOWN_WRITE);
    };
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sign", dependencyOverrideReason: overrideReason.trim() || null,
          outsideContractDecision: noChargeAdjustment && visit?.ortho?.adjustmentBillingClass === "OUTSIDE_CONTRACT"
            ? { decision: "no_charge", reason: noChargeReason.trim() } : null,
          orthoSession: orthoSession && visit?.ortho && visit.ortho.visitAdjustmentId === null
            ? {
              caseId: visit.ortho.caseId,
              upperWire: orthoSession.upperWire, lowerWire: orthoSession.lowerWire,
              elastics: orthoSession.elastics, elasticNote: orthoSession.elasticNote,
              done: orthoSession.done, nextWeeks: Number(orthoSession.nextWeeks) || 4,
            }
            : null,
        }),
      });
      if (!active()) return;
      if (!response.ok && !definitiveRejection(response.status)) { unknown(); return; }
      const payload: unknown = await response.json().catch(() => null);
      if (!active()) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) { readDeniedRef.current = true; setReadDenied(true); setReviewOpen(false); }
        const details: Record<string, unknown> = record(payload) ? payload : {};
        if (Array.isArray(details.unmetRequirements)) {
          setServerUnmet(details.unmetRequirements.filter((line): line is string => typeof line === "string"));
        }
        const conflicts = Array.isArray(details.sessionConflicts)
          ? details.sessionConflicts.filter((line): line is string => typeof line === "string") : [];
        setError([typeof details.message === "string" ? details.message : "تعذّر التوقيع.", ...conflicts].join(" "));
        return;
      }
      const result = signedResult(payload, visitId, patientId);
      if (!result || !record(payload)) { unknown(); return; }
      signedReceipt.current = result;
      setWriteHold({ kind: "signed", action: "sign", patientId, requiresSigned: true });
      // Lock immediately from the validated signature, even if GET fails or says open.
      setVisit({ ...visit, status: "signed", signedAt: payload.signedAt as string,
        invoiceId: result.invoiceId, signedBy: typeof payload.signedBy === "string" ? payload.signedBy : null });
      setServerUnmet([]); setReviewOpen(false); setOrthoSession(null);
      const refreshed = await load({ observeOnly: true, patientId });
      if (!active()) return;
      if (refreshed.status === "accepted" && refreshed.sequence === loadSequence.current && refreshed.visit.status === "signed") {
        applyRead(refreshed.visit); setWriteHold(null); setError(null);
      } else setError(SIGNED_REFRESH_FAILED);
      // The POST, not a GET or default values, owns the exact financial result.
      if (!readDeniedRef.current && !(refreshed.status === "unavailable" && refreshed.ownerChanged)) onSigned?.(result);
    } catch {
      if (signedReceipt.current) { if (active()) setError(SIGNED_REFRESH_FAILED); }
      else unknown();
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null; pendingAttempt.current = null;
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [currentOwner, interaction, scopeGeneration, setBusy, setWriteHold, visitId, load, applyRead, onSigned,
    overrideReason, orthoSession, visit, structuredClinical, noChargeAdjustment, noChargeReason]);

  /** (VISIT-2) فتح ملف المريض الجديد من زيارته — يعيد رقم الملف أو null مع رسالة الخطأ. */
  const openPatientFile = useCallback(async (id: number): Promise<number | null> => {
    if (busyRef.current || writeHoldRef.current || readDeniedRef.current || suspendedRef.current || !mountedRef.current || scope !== scopeRef.current || scopeGeneration !== scopeRecord.current.generation) return null;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open_file" }),
      });
      const payload = await response.json().catch(() => null);
      if (!mountedRef.current || scope !== scopeRef.current || scopeGeneration !== scopeRecord.current.generation) return null;
      if (!response.ok || !payload?.patientId) {
        setError(payload?.message ?? "تعذّر فتح ملف المريض.");
        return null;
      }
      return Number(payload.patientId);
    } catch {
      if (!mountedRef.current || scope !== scopeRef.current || scopeGeneration !== scopeRecord.current.generation) return null;
      setError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      if (mountedRef.current && scope === scopeRef.current && scopeGeneration === scopeRecord.current.generation) setBusy(false);
    }
  }, [scope, scopeGeneration, setBusy]);

  /* (VISIT-2) الوصول من «مراجعة وإنهاء» لمريضٍ فُتح ملفّه للتوّ: تُفتح المراجعة مرةً واحدة. */
  useEffect(() => {
    if (!autoReview || autoReviewDone.current || !visit || visit.id !== visitId || loadedGeneration !== scopeGeneration
      || visit.status !== "open" || !canWrite || !currentOwner() || writeHoldRef.current || readDeniedRef.current) return;
    autoReviewDone.current = true;
    setReviewOpen(true);
  }, [autoReview, visit, visitId, loadedGeneration, scopeGeneration, currentOwner, canWrite]);

  const holdNotice = writeHold ? (
    <section role="alert" data-testid="clinical-write-hold" className="mb-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p>{writeHold.kind === "unknown" ? UNKNOWN_WRITE : writeHold.kind === "signed" ? SIGNED_REFRESH_FAILED : SAVED_REFRESH_FAILED}</p>
      <p>التحديث قراءة فقط؛ لا يثبت أي طلبٍ حُفظ ولا أن طلبًا سابقًا انتهى. هذه الحماية داخل الشاشة الحالية ولا تبقى بعد المغادرة أو إعادة تحميل الصفحة.</p>
      <button type="button" data-testid="clinical-read-recovery" disabled={busy || suspended}
        className="rounded-lg border border-amber-500 px-3 py-2 font-bold disabled:opacity-40" onClick={() => void refreshHeldWrite()}>تحديث السجل للقراءة فقط</button>
      {!readDenied && writeHold.observed ? <div data-testid="clinical-observed-read" className="space-y-1 border-t border-amber-300 pt-2">
        <p className="font-bold">قراءة حالية للمقارنة؛ لم تُستبدل المسودة أدناه</p>
        <p>زيارة #{writeHold.observed.visit.id} · مريض #{writeHold.observed.visit.patientId} · {writeHold.observed.visit.status === "signed" ? "موقّعة حاليًا" : "مفتوحة حاليًا"}</p>
        <p>الطبيب #{writeHold.observed.visit.doctorId ?? "غير محدد"} · العملة {writeHold.observed.visit.billingCurrency ?? base}</p>
        {([["chiefComplaint", "الشكوى"], ["examination", "الفحص"], ["diagnosis", "التشخيص"], ["treatmentDone", "ما نُفّذ"], ["nextPlan", "الخطة القادمة"]] as const).map(([key, label]) => <p key={key} className="whitespace-pre-wrap">{label}: {writeHold.observed!.visit[key] ?? "—"}</p>)}
        {writeHold.observed.visit.procedures.map((line) => <p key={line.id}>{line.serviceName} · سن {line.toothCode ?? "—"} · كمية {line.quantity} · {formatMoney(line.unitPriceMinor, line.planCurrency ?? writeHold.observed!.visit.billingCurrency ?? base)} · طبيب #{line.doctorId ?? "—"}</p>)}
        {writeHold.action === "addendum" ? <p className="whitespace-pre-wrap">الملحق المحفوظ: {writeHold.observed.visit.addendum ?? "—"}</p> : null}
        {writeHold.kind !== "unknown" ? <button type="button" data-testid="clinical-accept-read"
          disabled={busy || suspended || (writeHold.requiresSigned && writeHold.observed.visit.status !== "signed")}
          className="rounded-lg border border-amber-500 px-3 py-2 font-bold disabled:opacity-40" onClick={acceptHeldRead}>راجعت القراءة؛ اعتمادها بدل المسودة</button> : <p>تبقى إعادة الطلب مقفلة. راجع النتيجة مع المسؤول؛ القراءة وحدها لا تسمح بتكرار الحفظ أو التوقيع.</p>}
      </div> : null}
      {!readDenied && writeHold.kind === "signed" && signedReceipt.current ? <p data-testid="clinical-known-sign-result">نتيجة التوقيع المؤكدة: {formatMoney(signedReceipt.current.duesMinor, signedReceipt.current.invoiceCurrency ?? base)} · جلسات {signedReceipt.current.sessionsCompleted}{signedReceipt.current.invoiceId ? ` · فاتورة #${signedReceipt.current.invoiceId}` : ""}</p> : null}
    </section>
  ) : null;
  if (!visit || visit.id !== visitId || loadedGeneration !== scopeGeneration || readDenied) {
    return <div>{holdNotice}<p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
      {readDenied ? "تعذّر التحقق من صلاحية عرض هذه الزيارة؛ البيانات محجوبة حتى قراءة مأذونة." : error ?? "جارٍ التحميل…"}
    </p></div>;
  }

  const signed = visit.status === "signed";
  // Category metadata describes eligible work, never order/procedure provenance.
  const eligibleLabWork = Array.from(new Set(drafts.map((draft) => labWorkForCategory(draft.labCategory))
    .filter((work): work is string => typeof work === "string")));
  const updateDrafts = (update: (rows: Draft[]) => Draft[]) => {
    // Procedure changes also regenerate treatmentDone.
    if (!canEditOwnedDraft()) return;
    setDrafts(update);
  };
  const lines = drafts.map((draft) => ({
    quantity: draft.quantity,
    unitPriceMinor: parseAmount(draft.price, draft.currency) ?? 0,
  }));
  const total = visitTotal(lines);

  /* المجاميع بعملاتها المستقلة — لا إجمالي رقمي واحد عبر عملتين أبدًا:
   * عملةٌ واحدة ⇒ الإجمالي المألوف نفسه؛ عملتان ⇒ سطرٌ لكل عملة + تحذير
   * صريح، ورفض الخادم (mixed_plan_currencies) يبقى الحارس خلف الشاشة.
   * (المراجعة النهائية) الدلو من عملة السطر نفسه — `draft.currency`. */
  const currencyTotals: { currency: Currency; totalMinor: number }[] = [];
  for (const draft of drafts) {
    const lineTotal = (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity;
    const bucket = currencyTotals.find((row) => row.currency === draft.currency);
    if (bucket) bucket.totalMinor += lineTotal;
    else currencyTotals.push({ currency: draft.currency, totalMinor: lineTotal });
  }
  const mixedCurrencies = currencyTotals.length > 1;
  const singleCurrency = currencyTotals[0]?.currency ?? base;
  /* (DAY1) السطر الحر بعملة الزيارة وسعر الدليل بها؛ بلا سعرٍ بها يُكتب يدويًّا. */
  const addFreeProcedure = (service: Service) => {
    if (!canEditOwnedDraft()) return;
    const catalog = catalogFor(service, visitCurrency);
    updateDrafts((rows) => [
      ...rows,
      {
        labCategory: service.category,
        serviceId: service.id,
        toothCode: "",
        surfaces: "",
        quantity: 1,
        price: catalog.minor !== null ? formatAmount(catalog.minor, visitCurrency) : "",
        doctorId,
        planItemId: null,
        currency: visitCurrency,
      },
    ]);
  };
  /* (P6) من الخادم وحده: صفرٌ بقواعد الفوترة، أو مستحقٌّ بعملةٍ واحدة. المزيج يبقى تحذيره كما هو. */
  const serverDueEntries = billingPreview && !billingPreview.mixedCurrencies && !mixedCurrencies
    ? (Object.entries(billingPreview.duesByCurrency) as [Currency, number][]).filter(([, minor]) => minor > 0)
    : null;
  const serverZeroDue = serverDueEntries !== null && serverDueEntries.length === 0;
  const serverDue = serverDueEntries && serverDueEntries.length === 1
    ? { currency: serverDueEntries[0][0], minor: serverDueEntries[0][1] } : null;
  /* (DOCATTR-1) عملٌ مستحقٌّ بلا طبيبٍ معالج: الخادم ينسبه لطبيب الزيارة أو للطبيب الموقِّع،
     وإلا يرفض التوقيع — فتقولها الشاشة قبل الضغط لا بعده. */
  /* قرار طلب السبب من نتيجة التوقيع داخل المعاملة؛ التحذير السابق قد يتحقق في الزيارة نفسها. */
  const unmetInVisit = serverUnmet;
  const ownerlessPricedWork = doctorId === null && drafts.some((draft) =>
    draft.doctorId === null && (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity > 0);

  const payload = () => ({
    ...notes, doctorId,
    billingCurrency: visitCurrency,
    procedures: drafts.map((draft) => ({
      serviceId: draft.serviceId,
      toothCode: draft.toothCode ? Number(draft.toothCode) : null,
      surfaces: draft.surfaces || null,
      quantity: draft.quantity,
      unitPriceMinor: parseAmount(draft.price, draft.currency) ?? 0,
      priceReason: draft.priceReason?.trim() || null,
      doctorId: draft.doctorId,
      planItemId: draft.planItemId,
    })),
  });

  /*
   * «مخطَّط لليوم» — بنود الخطة التي لم تكتمل، مع سعر جلستها القادمة وفق قاعدة
   * الفوترة. الإضافة منها تربط الإجراء ببنده فيملك الخادمُ السعر، وتُنجَز الجلسة
   * عند التوقيع فيتقدّم البند من نفسه (المواصفة §١٣).
   */
  const addedItemIds = new Set(drafts.map((draft) => draft.planItemId).filter((id): id is number => id !== null));
  const plannedToday = visit.outstanding.filter((item) => !addedItemIds.has(item.planItemId));
  const doneToday = drafts.filter((draft) => draft.planItemId !== null);
  const notDoneToday = visit.outstanding.filter((item) => !addedItemIds.has(item.planItemId));

  const addPlannedItem = (item: Visit["outstanding"][number]) => {
    if (!canEditOwnedDraft()) return;
    if (drafts.some((row) => row.planItemId === item.planItemId)) {
      focusedProcedure.current?.focus({ preventScroll: true });
      return;
    }
    // سعر الجلسة القادمة وفق قاعدة البند — نفس دالة الخادم، فيتطابق الرقمان.
    const lineTotal = item.unitPriceMinor * item.quantity;
    const sessionIndex = item.doneSessions + 1;
    const suggested = item.includedByAgreement ? 0 : priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
    /* (المراجعة النهائية للمالك — TD-05) السعر المقترح يُنسَّق بعملة **بند
       الخطة هذا نفسه** لا بعملةٍ مستنتَجة على مستوى الزيارة: زيارةٌ فارغة لا
       إجراءاتٍ فيها لا تعرف عملتها، فبندٌ دولاري مخزّنٌ ١٥٠٠٠٠ وحدة صغرى
       يُعرض «1,500.00» فورًا — لا «150,000» بالأساس أبدًا. */
    const itemCurrency = isCurrency(item.planCurrency) ? item.planCurrency : base;
    /* (DAY1) زيارةٌ بلا إجراءٍ حرّ تتبع عملة خطة بندها — فلا تتعارض العملتان عند التوقيع. */
    if (!drafts.some((row) => row.planItemId === null)) setVisitCurrency(itemCurrency);
    updateDrafts((rows) => rows.some((row) => row.planItemId === item.planItemId) ? rows : [
      ...rows,
      {
        // Plan staging has no canonical category; a later accepted save/read supplies it.
        labCategory: null,
        serviceId: item.serviceId ?? 0,
        toothCode: item.toothCode ? String(item.toothCode) : "",
        surfaces: "",
        quantity: 1,
        price: formatAmount(suggested, itemCurrency),
        doctorId,
        planItemId: item.planItemId,
        currency: itemCurrency,
      },
    ]);
  };

  const reviewedItemExists = workResult?.status === "ready" && drafts.some((row) => row.planItemId === workFocus?.itemId
    && row.serviceId === workResult.item.serviceId && (row.toothCode === "" ? null : Number(row.toothCode)) === workResult.item.toothCode);
  const stageReviewedWork = async () => {
    if (!mountedRef.current || scopeGeneration !== scopeRecord.current.generation || workKeyRef.current !== workKey || !workFocus || workResult?.status !== "ready" || busyRef.current || writeHoldRef.current || readDeniedRef.current || suspendedRef.current) return;
    const capturedKey = workKey;
    const capturedDraft = currentDraftKey.current;
    const capturedFingerprint = workResult.fingerprint;
    setBusy(true);
    try {
      const snapshot = await readVisitWorkSnapshot(workFocus);
      const current = workContext.current;
      if (!mountedRef.current || scopeGeneration !== scopeRecord.current.generation || suspendedRef.current || workKeyRef.current !== capturedKey || !current.visit || !current.workFocus) return;
      const result = resolveVisitWork({ focus: current.workFocus, patientId: current.workFocus.patientId,
        visitId, canEditWork: current.canEditWork, snapshot, loadedVisit: current.visit, drafts: current.drafts });
      if (capturedDraft !== currentDraftKey.current || (result.status === "ready" && result.fingerprint !== capturedFingerprint)) {
        setWorkRead({ key: capturedKey, result: { status: "unavailable", reason: "changed" } }); return;
      }
      setWorkRead({ key: capturedKey, result });
      if (result.status !== "ready") return;
      if (result.existing) { focusedProcedure.current?.scrollIntoView({ block: "center" }); focusedProcedure.current?.focus({ preventScroll: true }); return; }
      // No POST, save, sign or alternate price/provider path. Revalidation only
      // releases the same canonical staging handler for this explicit click.
      setBusy(false);
      addPlannedItem(result.item);
      setWorkRead({ key: capturedKey, result: { ...result, existing: true } });
    } catch {
      if (mountedRef.current && scopeGeneration === scopeRecord.current.generation && workKeyRef.current === capturedKey) setWorkRead({ key: capturedKey, result: { status: "unavailable", reason: "hidden" } });
    } finally { if (mountedRef.current && scopeGeneration === scopeRecord.current.generation && scope === scopeRef.current) setBusy(false); }
  };

  /* ملاحظة جلسةٍ لسطرٍ مرتبط ببند — تُحسب هنا من بيانات البند نفسها بنفس دوال
   * الخادم، فتظهر للطبيب على الشاشة الجملة التي سيحكم بها الخادم عند التوقيع. */
  const sessionNoteForDraft = (draft: Draft, index: number): string | null => {
    if (draft.planItemId === null || !visit) return null;
    const item = visit.outstanding.find((row) => row.planItemId === draft.planItemId);
    if (!item) return null;
    const occurrencesBefore = drafts
      .slice(0, index)
      .filter((row) => row.planItemId === draft.planItemId).length;
    const sessionIndex = item.doneSessions + occurrencesBefore + 1;
    return sessionPriceNote(item.billingRule, sessionIndex, item.sessionCount);
  };

  const savedSpecialtyReview = (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-3" data-testid="saved-specialty-review">
      <dt className="font-extrabold text-sky-900">التوثيق التخصصي المحفوظ لهذه الزيارة</dt>
      <dd className="mt-1 text-[11px] text-slate-600">سجلات محفوظة فقط. التعديلات غير المحفوظة داخل التخصص لا تظهر هنا، ولا تُنسخ هذه السجلات إلى الملاحظات أو الإجراءات.</dd>
      {!structuredClinical ? <dd role="status" className="mt-2">جارٍ تحديث السجلات المحفوظة…</dd>
        : structuredClinical.status === "unavailable" ? <dd role="alert" className="mt-2 text-danger-700">
          تعذّر التحقق من السجلات التخصصية. حدّثها قبل التوقيع؛ لا يعني ذلك عدم وجود توثيق.
          <button type="button" className="ms-2 underline" onClick={() => setStructuredRetry((value) => value + 1)}>أعد تحميل التوثيق</button>
        </dd> : <>
          <dd className="mt-1 text-[11px]">زيارة #{structuredClinical.visitId}{structuredClinical.visitCaseId ? ` · حالة الزيارة #${structuredClinical.visitCaseId}` : ""} · {structuredClinical.signedAt
            ? `موقّعة بواسطة ${structuredClinical.signedBy ?? "غير مسجّل"}` : "محفوظة · الزيارة غير موقّعة"}</dd>
          {structuredClinical.endodontics.map((record) => <dd key={`endo:${record.id}`} className="mt-2 border-t border-sky-200 pt-2">
            <p className="font-bold">علاج الجذور · سن {record.toothCode} · {ENDO_STAGE_LABEL[record.stage]}</p>
            <p>سجل #{record.id} · نوبة #{record.treatmentId} · حالة #{record.caseId} · إصدار {record.version}</p>
            <p>الطبيب المسجّل: {record.doctorName ?? "غير مسجّل"}{record.doctorId ? ` (#${record.doctorId})` : ""}</p>
            <p>القنوات: {record.canalCount} · طول عامل مسجّل: {record.measuredCanalCount} · حشو قنوات موثّق: {record.obturatedCanalCount}</p>
          </dd>)}
          {structuredClinical.periodontics.map((record) => <dd key={`perio:${record.id}`} className="mt-2 border-t border-sky-200 pt-2">
            <p className="font-bold">فحص اللثة · سجل #{record.id} · إصدار {record.revision}{record.caseId ? ` · حالة #${record.caseId}` : ""}</p>
            <p>الطبيب المسجّل: {record.doctorName ?? "غير مسجّل"} (#{record.doctorId})</p>
            <p>مواضع محفوظة: {record.siteCount} على {record.toothCount} أسنان · عمق مسجّل: {record.recordedDepthSites} · نزف مسجّل نعم/لا: {record.recordedBleedingSites}</p>
          </dd>)}
          {structuredClinical.endodontics.length + structuredClinical.periodontics.length === 0
            ? <dd className="mt-2">لا توجد سجلات جذور أو لثة محفوظة لهذه الزيارة.</dd> : null}
          <dd className="mt-2 text-[11px] text-slate-600">هذه مراجع توثيق، وليست إجراءات مالية. يتحقق التوقيع من وجود توثيق سريري فعلي؛ المرحلة أو السجل الفارغ وحدهما لا يكفيان.</dd>
        </>}
    </div>
  );

  return (
    <div>
      {holdNotice}
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

      {workFocus ? <section aria-label="مراجعة بند الخطة في الزيارة" data-testid="visit-work-review" className="mb-4 rounded-xl border border-teal-300 bg-teal-50 p-4 text-sm">
        <h3 className="font-bold">مراجعة بند موجود قبل إضافته إلى الزيارة</h3>
        <p className="mt-1 text-xs">مريض #{workFocus.patientId} · زيارة #{workFocus.visitId} · خطة #{workFocus.planId} · بند #{workFocus.itemId} · {workFocus.caseId === null ? "غير مرتبط بحالة" : `حالة #${workFocus.caseId}`} · {workFocus.toothCode === null ? "دون سن محدد" : `سن ${workFocus.toothCode}`}</p>
        {!workResult ? <p role="status" className="mt-2">جارٍ التحقق من السجل الحالي…</p>
          : workResult.status === "unavailable" ? <p role="alert" className="mt-2">{VISIT_WORK_FAILURE[workResult.reason]}</p>
          : <>
            <p className="mt-2 font-bold">{workResult.item.serviceName}</p>
            <p className="mt-1 text-xs">طبيب البند المسجّل: {workResult.planItem.doctorName ?? "غير مسجل"}{workResult.planItem.doctorId ? ` (#${workResult.planItem.doctorId})` : ""} · طبيب الإجراء الحالي: {doctorId === null ? "غير محدد" : doctors.find((row) => row.id === doctorId)?.name ?? `#${doctorId}`}</p>
            {workResult.item.unmetRequirements?.length ? <p className="mt-1 text-xs text-amber-900">متطلبات التوقيع: {workResult.item.unmetRequirements.join("، ")}</p> : null}
            <button type="button" data-testid="visit-work-stage" disabled={busy || !!writeHold || readDenied || suspended || !canEditWork || signed} className="mt-3 min-h-11 rounded-lg bg-teal-800 px-4 py-2 font-bold text-white disabled:opacity-50" onClick={() => void stageReviewedWork()}>{reviewedItemExists ? "البند موجود في إجراءات الزيارة · عرضه" : "أضف هذا البند إلى مسودة الزيارة"}</button>
          </>}
        <button type="button" data-testid="visit-work-refresh" disabled={busy || !!writeHold || readDenied || suspended} className="ms-3 mt-3 min-h-11 underline" onClick={() => setWorkRetry((value) => value + 1)}>تحديث المراجعة</button>
        <p className="mt-2 text-xs">فتح هذه المراجعة لا يحفظ أو يفوتر. الإضافة تبقى مسودة؛ الحفظ والتوقيع من أزرار الزيارة المعتادة وبقواعد خطتها.</p>
      </section> : null}

      {visit.referral ? (
        /* (REF-3) لافتة الإحالة (§6): من أحال ولماذا وأي الأسنان وما الذي يتوقف عليها — للقراءة لا قرار. */
        <div role="note" className="mb-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-950">
          <p className="font-extrabold">
            📨 محال{visit.referral.fromName ? ` من ${visit.referral.fromName}` : ""} — السبب: {visit.referral.reason}
            {visit.referral.teeth ? ` — الأسنان: ${visit.referral.teeth}` : ""}
          </p>
          {visit.referral.caseTitle || visit.referral.blocksCaseTitle ? (
            <p className="mt-0.5 font-semibold text-indigo-900">
              {visit.referral.caseTitle ? `الحالة: ${visit.referral.caseTitle}` : ""}
              {visit.referral.caseTitle && visit.referral.blocksCaseTitle ? " · " : ""}
              {visit.referral.blocksCaseTitle ? `«${visit.referral.blocksCaseTitle}» متوقفة على هذا` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={`mb-4 flex flex-wrap items-center gap-2 rounded-2xl border-2 p-3 ${
        signed ? "border-success-300 bg-success-50" : "border-navy-800 bg-white"
      }`}>
        <Icon name={signed ? "check" : "clock"} className={`h-5 w-5 ${signed ? "text-success-700" : "text-navy-800"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-navy-900">
            {signed ? "زيارة موقَّعة" : "زيارة مفتوحة"} — {visit.patientName}
          </p>
          {signed ? (
            <p className="text-[11px] font-semibold text-slate-500">
              وقّعها {visit.signedBy} · {visit.signedAt?.slice(0, 10)}
              {visit.invoiceId ? ` · فاتورة #${visit.invoiceId}` : " · بلا فاتورة"}
            </p>
          ) : null}
        </div>
        {signed && visit.invoiceId ? (
          <a href={`/print/invoice/${visit.invoiceId}`} target="_blank" rel="noopener"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
            الفاتورة
          </a>
        ) : null}
        {/* وصفة طبية من مساحة العمل — بلا الرجوع لرأس ملف المريض. */}
        {visit.patientId ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setRxOpen(true)}
              className="flex items-center gap-1 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 transition-colors"
            >
              <span>💊</span>
              <span>روشتة طبية (℞)</span>
            </button>
            <button
              type="button"
              onClick={() => setPostOpOpen(true)}
              className="flex items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              <span>📋</span>
              <span>إرشادات المريض</span>
            </button>
          </div>
        ) : null}
      </div>

      {signed ? <dl className="mb-3 text-xs">{savedSpecialtyReview}</dl> : null}

      <VisitSteps steps={[
        { id: "visit-notes", label: "الشكوى", done: Boolean(notes.chiefComplaint.trim()) || signed },
        { id: "visit-notes", label: "الفحص والتشخيص", done: Boolean(notes.examination.trim() || notes.diagnosis.trim()) || signed },
        { id: "visit-procedures", label: "الإجراءات", done: drafts.length > 0 || signed },
        { id: "visit-sign", label: "المراجعة والتوقيع", done: signed },
      ]} />

      {/*
        * سياق الرحلة قبل الحقول: الزيارة المخطَّطة التي جاءت منها هذه الزيارة،
        * وآخر زيارة قبلها — ما عُمل آخر مرة يُقرأ لا يُخمَّن (المواصفة §١٢).
        */}
      {visit.plannedVisit ? (
        <div className="mb-3 rounded-xl border border-navy-200 bg-navy-50 px-3 py-2">
          <p className="text-xs font-extrabold text-navy-900">
            مخطَّط لهذه الزيارة: {visit.plannedVisit.title}
            {visit.plannedVisit.planTitle ? ` · ${visit.plannedVisit.planTitle}` : ""}
          </p>
          <p className="text-[11px] text-navy-800">
            زيارة {visit.plannedVisit.sequence} · مدة مقترحة {visit.plannedVisit.durationMinutes} دقيقة
          </p>
        </div>
      ) : null}

      {!signed && visit.previousVisit ? (
        <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-extrabold text-slate-700">
            آخر زيارة ({visit.previousVisit.date}):
          </p>
          <p className="text-[11px] text-slate-600">
            {visit.previousVisit.proceduresSummary ?? visit.previousVisit.treatmentDone ?? "كشف"}
            {visit.previousVisit.nextPlan ? ` · الخطة حينها: ${visit.previousVisit.nextPlan}` : ""}
          </p>
        </div>
      ) : null}

      {/* (P0-E) سياق المريض للطبيب: آخر تشخيص والحالات الجارية بخطوتها التالية — لا سياق فارغ عند الفتح. */}
      {!signed && (visit.latestDiagnosis || (visit.activeCases?.length ?? 0) > 0) ? (
        <section className="mb-3 rounded-xl border border-navy-200 bg-white px-3 py-2" aria-label="سياق المريض">
          {visit.latestDiagnosis ? (
            <p className="text-[11px] text-slate-700">
              <span className="font-extrabold text-navy-900">آخر تشخيص</span> ({visit.latestDiagnosis.date}): {visit.latestDiagnosis.text}
            </p>
          ) : null}
          {(visit.activeCases ?? []).filter((one) => one.kind !== "ortho" || !visit.ortho).map((one) => (
            <p key={`${one.kind}-${one.id ?? one.title}`} className="mt-1 text-[11px] text-slate-700">
              <span className="font-extrabold text-navy-900">{one.title}</span>
              {one.status === "waiting" ? <span className="text-amber-700"> · بانتظار</span> : null}
              {one.totalSteps > 0 ? <span className="text-slate-500"> · {one.doneSteps}/{one.totalSteps}</span> : null}
              {one.nextStep ? <span> · التالي: {one.nextStep}</span> : null}
              {one.responsibleName ? <span className="text-slate-500"> · {one.responsibleName}</span> : null}
            </p>
          ))}
        </section>
      ) : null}

      <div id="visit-notes" className="mb-4 grid scroll-mt-4 gap-2 sm:grid-cols-2">
        {([
          ["chiefComplaint", "① الشكوى الرئيسية", phrases.chiefComplaint],
          ["examination", "② الفحص", phrases.examination],
          ["diagnosis", "② التشخيص", phrases.diagnosis],
        ] as [NoteKey, string, string[]][]).map(([key, label, list]) => (
          <Field key={key} label={label} value={notes[key]} disabled={signed || busy || !!writeHold || readDenied || suspended}
            auto={autoFilled.has(key)} phrases={signed ? [] : list}
            onPhrase={(phrase) => setNote(key, appendPhrase(notes[key], phrase))}
            onChange={(value) => setNote(key, value)} />
        ))}
        <Field label="③ ما نُفّذ" value={notes.treatmentDone} disabled={signed || busy || !!writeHold || readDenied || suspended}
          hint={!signed && notes.treatmentDone && notes.treatmentDone === lastAutoTreatment.current ? "يُكتب من الإجراءات المضافة أدناه" : undefined}
          onChange={(value) => setNote("treatmentDone", value)} />
        <Field label="الخطة القادمة" value={notes.nextPlan} disabled={signed || busy || !!writeHold || readDenied || suspended}
          auto={autoFilled.has("nextPlan")} phrases={signed ? [] : phrases.nextPlan}
          onPhrase={(phrase) => setNote("nextPlan", appendPhrase(notes.nextPlan, phrase))}
          onChange={(value) => setNote("nextPlan", value)} />
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">
            الطبيب المعالج
            {autoFilled.has("doctor") ? <span className="mr-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">✨ تلقائي</span> : null}
          </span>
          <select value={doctorId ?? ""} disabled={signed || busy || !!writeHold || readDenied || suspended || !canEditWork}
            onChange={(event) => {
              if (!canEditOwnedDraft()) return;
              setDoctorId(Number(event.target.value) || null);
              setAutoFilled((current) => { const next = new Set(current); next.delete("doctor"); return next; });
            }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

      {/* مخطَّط لليوم — من بنود الخطة، بأسعار جلساتها من الخطة */}
      {!signed && plannedToday.length > 0 ? (
        <section className="mb-4 rounded-2xl border border-navy-200 bg-navy-50/40 p-3" aria-label="مخطَّط لليوم">
          <fieldset disabled={busy || !!writeHold || readDenied || suspended || !canEditWork} className="m-0 min-w-0 border-0 p-0">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            مخطَّط لهذا المريض — من خطط علاجه
          </h3>
          <ul className="space-y-1.5">
            {plannedToday.map((item) => {
              const sessionIndex = item.doneSessions + 1;
              const lineTotal = item.unitPriceMinor * item.quantity;
              const price = item.includedByAgreement ? 0 : priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
              return (
                <li key={item.planItemId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-navy-900">
                      {item.serviceName}
                      {item.toothCode ? <span className="rounded-lg bg-navy-50 px-1.5 py-0.5 mr-1.5 text-[10px] font-bold text-navy-800">سن {item.toothCode}</span> : null}
                      {item.sessionCount > 1 ? (
                        <span className="text-[10px] font-normal text-slate-500">
                          {" "}· جلسة {sessionIndex} من {item.sessionCount}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {item.includedByAgreement
                        ? "مشمولة في اتفاق الأقساط — لا تُفوتر الجلسة"
                        : <>{BILLING_RULE_LABEL[item.billingRule]}{price === 0 ? " — تُسعَّر هذه الجلسة وفق قاعدة البند" : ""}</>}
                      {" · من «"}{item.planTitle}{"»"}
                    </p>
                    {item.unmetRequirements && item.unmetRequirements.length > 0 ? (
                      <p className="text-[10px] font-bold text-amber-800">⚠️ يتطلب أولًا: {item.unmetRequirements.join("، ")}</p>
                    ) : null}
                  </div>
                  <button type="button" onClick={() => addPlannedItem(item)}
                    className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-[11px] font-extrabold text-navy-800 hover:bg-navy-50">
                    + نفّذ اليوم
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
            سعر الجلسة يأتي من الخطة وفق قاعدة فوترة البند — عند البدء أو الإكمال أو
            لكل جلسة — ولا يُكتب من الشاشة.
          </p>
          </fieldset>
        </section>
      ) : null}

      <section id="visit-procedures" className="mb-4 scroll-mt-4" aria-label="الإجراءات المنفَّذة">
        <fieldset disabled={busy || !!writeHold || readDenied || suspended || !canEditWork} className="m-0 min-w-0 border-0 p-0">
        {!signed && canWrite ? (
          <div className="mb-2 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="عملة الزيارة">
            <span className="text-xs font-extrabold text-navy-900">عملة الزيارة:</span>
            {CURRENCY_CHOICES.map((choice) => (
              <button key={choice.value} type="button" role="radio" aria-checked={visitCurrency === choice.value}
                onClick={() => {
                  if (!canEditOwnedDraft() || choice.value === visitCurrency) return;
                  setVisitCurrency(choice.value);
                  /* الإجراءات الحرّة تنتقل للعملة الجديدة بسعر دليلها — وبنود الخطة تبقى بعملة خطتها. */
                  updateDrafts((rows) => rows.map((row) => {
                    if (row.planItemId !== null) return row;
                    const service = services.find((item) => item.id === row.serviceId);
                    const catalog = service ? catalogFor(service, choice.value) : null;
                    return {
                      ...row,
                      currency: choice.value,
                      price: catalog && catalog.minor !== null ? formatAmount(catalog.minor, choice.value) : "",
                      priceReason: undefined,
                    };
                  }));
                }}
                className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${visitCurrency === choice.value
                  ? "border-navy-800 bg-navy-800 text-white" : "border-slate-300 bg-white text-navy-800"}`}>
                {choice.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-navy-900">الإجراءات المنفَّذة</h3>
          {/* (TD-05 second owner review — Finding 7) عملةٌ واحدة: الإجمالي
              المألوف. عملتان: مجموعان منفصلان موسومان + تحذير — لا رقمٌ واحد
              يجمع دولارًا بغير عملته أبدًا. */}
          {mixedCurrencies ? (
            <span className="flex flex-col items-end" data-testid="currency-subtotals">
              {currencyTotals.map((bucket) => (
                <span key={bucket.currency} className="text-sm font-extrabold text-navy-900">
                  {formatMoney(bucket.totalMinor, bucket.currency)}
                </span>
              ))}
              <span className="text-[10px] font-bold text-danger-700" data-testid="mixed-currency-warning">
                زيارة بعملتين — لا تُوقَّع فاتورةً واحدة: فاصل الإجراءات أو أنجزها في زيارةٍ مستقلة
              </span>
            </span>
          ) : (
            <span className="text-sm font-extrabold text-navy-900">{formatMoney(total, singleCurrency)}</span>
          )}
        </div>

        {drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs font-semibold text-slate-400">
            لا إجراءات. الزيارة بلا إجراء تُوقَّع كشفًا بلا فاتورة.
          </p>
        ) : (
          <ul className="space-y-2">
            {drafts.map((draft, index) => {
              const service = services.find((row) => row.id === draft.serviceId);
              const note = sessionNoteForDraft(draft, index);
              return (
                <li key={index} ref={workFocus?.itemId === draft.planItemId ? focusedProcedure : undefined} tabIndex={workFocus?.itemId === draft.planItemId ? -1 : undefined} data-focused-visit-item={workFocus?.itemId === draft.planItemId ? String(draft.planItemId) : undefined} className={`rounded-xl border p-3 ${
                  draft.planItemId ? "border-navy-200 bg-navy-50/30" : "border-slate-200 bg-white"
                }`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-navy-900">{service?.name ?? "خدمة"}</span>
                    {draft.toothCode ? (
                      <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[11px] font-bold text-navy-800">
                        {toothName(Number(draft.toothCode))}
                      </span>
                    ) : null}
                    {draft.planItemId ? (
                      <span className="rounded-lg bg-emerald-100 px-2 py-0.5 text-[10px] font-extrabold text-emerald-800">
                        من الخطة — سعرها من قاعدة البند
                      </span>
                    ) : null}
                    {note ? (
                      <span className="text-[10px] text-slate-500">{note}</span>
                    ) : null}
                    {!signed ? (
                      <button onClick={() => updateDrafts((rows) => rows.filter((_, i) => i !== index))}
                        className="mr-auto rounded-lg px-2 py-1 text-[11px] font-bold text-danger-700 hover:bg-danger-50">
                        احذف
                      </button>
                    ) : (
                      <span className="mr-auto text-sm font-bold text-navy-900">
                        {formatMoney(
                          draft.quantity * (parseAmount(draft.price, draft.currency) ?? 0),
                          draft.currency,
                        )}
                      </span>
                    )}
                  </div>
                  {!signed ? (
                    <div className="flex flex-wrap gap-2">
                      <ToothField value={draft.toothCode} className="w-24"
                        onChange={(toothCode) => updateDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, toothCode } : row))}
                        invalid={Boolean(draft.toothCode) && !isValidTooth(Number(draft.toothCode))} />
                      <input value={draft.surfaces} dir="ltr"
                        onChange={(event) => updateDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, surfaces: event.target.value } : row))}
                        placeholder="الأسطح" aria-label="الأسطح"
                        className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.quantity} type="number" min={1} dir="ltr"
                        onChange={(event) => updateDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, quantity: Math.max(1, Number(event.target.value) || 1) } : row))}
                        aria-label="الكمية"
                        className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      <input value={draft.price} inputMode="decimal" dir="ltr"
                        onChange={(event) => updateDrafts((rows) => rows.map((row, i) =>
                          i === index ? { ...row, price: event.target.value } : row))}
                        aria-label="السعر"
                        disabled={draft.planItemId !== null}
                        title={draft.planItemId !== null ? "سعر إجراء الخطة يُحسب من الخطة وفق قاعدة الفوترة" : undefined}
                        className="min-w-[6rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold disabled:bg-slate-50 disabled:text-slate-500" />
                      {(() => {
                        /* (P1-6) السعر من الدليل؛ أي انحرافٍ عنه يحتاج سببًا يُدقَّق — والخادم
                           يفرض حدّ الخصم ويمنع الرفع لغير المدير. */
                        if (draft.planItemId !== null) return null;
                        const catalogService = services.find((row) => row.id === draft.serviceId);
                        const typed = parseAmount(draft.price, draft.currency);
                        const catalog = catalogService ? catalogFor(catalogService, draft.currency) : null;
                        if (!catalog || !catalog.configured || catalog.minor === null
                            || typed === null || typed === catalog.minor) return null;
                        return (
                          <input value={draft.priceReason ?? ""}
                            onChange={(event) => updateDrafts((rows) => rows.map((row, i) =>
                              i === index ? { ...row, priceReason: event.target.value } : row))}
                            placeholder={`سبب تغيير السعر (الدليل: ${formatAmount(catalog.minor, draft.currency)})`}
                            aria-label="سبب تغيير السعر"
                            maxLength={300}
                            className="w-full rounded-xl border border-warning-300 bg-warning-50 px-3 py-2 text-sm" />
                        );
                      })()}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {!signed && !writeHold && !suspended && eligibleLabWork.length > 0 ? (
          <p role="note" data-testid="clinical-lab-sign-guidance" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-900">
            عند توقيع الزيارة بعد مراجعتها سريريًا، ينشئ النظام طلب مختبر «لم يُرسل بعد» للعمل المؤهل ({eligibleLabWork.join("، ")}) إذا لم يوجد طلب قائم وفق قواعد النظام. لا توقّع الزيارة لمجرد إنشاء طلب مختبر.
          </p>
        ) : null}

        {!signed && canWrite ? (
          <div className="mt-3 rounded-2xl border border-dashed border-navy-300 bg-navy-50/50 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="block text-xs font-extrabold text-navy-900">+ إجراء غير مخطَّط — من الدليل</span>
              <button type="button" onClick={() => setPickerOpen(true)}
                className="rounded-xl border border-navy-800 bg-white px-3 py-1.5 text-[11px] font-black text-navy-800">
                🔍 بحث سريع
              </button>
            </div>
            <QuickServicePicker
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              currency={visitCurrency}
              services={services}
              allowUnpriced
              title="أضف إجراءً للزيارة"
              onPick={(service) => addFreeProcedure(service as Service)}
            />
            <ServiceSelect
              services={services}
              value={null}
              onChange={(id, service) => {
                if (!service) return;
                addFreeProcedure(service as Service);
              }}
              base={base}
              placeholder="+ انقر لاختيار إجراء من الدليل المصنف…"
              ariaLabel="أضف إجراءً"
            />
          </div>
        ) : null}
        </fieldset>
      </section>

      <section aria-label="طلبات المختبر المرتبطة بالزيارة" data-testid="clinical-visit-lab-orders" className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs">
        <h3 className="font-bold text-sky-900">طلبات المختبر المرتبطة بالزيارة</h3>
        <p className="mt-1 text-slate-600">هذه قائمة الزيارة؛ لا تثبت ارتباط الطلب بإجراء محدد أو بطبيبه.</p>
        {visit.labOrders.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {visit.labOrders.map((order) => (
              <li key={order.id} data-lab-order-id={order.id}>
                #{order.id} · {order.workType} · {order.toothCode === null ? "دون سن محدد" : `سن ${order.toothCode}`} · {Object.prototype.hasOwnProperty.call(LAB_STATUS_LABEL, order.status) ? LAB_STATUS_LABEL[order.status as LabOrderStatus] : order.status}
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-slate-600">لا توجد طلبات مختبر في القراءة الحالية لهذه الزيارة.</p>}
      </section>

      {/* (P4) المواد المصروفة: التلقائية من ربط الخدمات واليدوية لهذه الزيارة — من سجل حركات المخزون نفسه. */}
      {/* (P0-F) المساعد السريري لا يصرف مخزونًا ولا يرى سجل المواد — للطبيب والإدارة. */}
      {canEditWork ? <VisitMaterials visitId={visit.id} canAdd={canWrite && !busy && !writeHold && !suspended} /> : null}

      {signed ? (
        <section aria-label="الملاحق">
          {visit.addendum ? (
            <pre className="mb-3 whitespace-pre-wrap rounded-xl border border-warning-300 bg-warning-50 p-3 text-[11px] font-semibold leading-5 text-warning-900">
              {visit.addendum}
            </pre>
          ) : null}
          {canWrite ? (
            <>
              <textarea disabled={busy || !!writeHold || suspended} value={addendum} onChange={(event) => { if (canEditOwnedDraft()) setAddendum(event.target.value); }}
                rows={2} placeholder="ملحق تصحيحي — يُضاف ولا يمحو ما قبله"
                aria-label="ملحق"
                className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
              <button
                onClick={async () => {
                  await send({ action: "addendum", text: addendum });
                }}
                disabled={busy || !!writeHold || readDenied || suspended || !addendum.trim()}
                className="rounded-xl border border-warning-300 bg-warning-50 px-4 py-2 text-sm font-bold text-warning-900 disabled:opacity-40">
                أضف ملحقًا
              </button>
            </>
          ) : null}
        </section>
      ) : canWrite ? (
        <>
          {visit.patientId === null ? (
            <LinkPatient visitId={visit.id} suggestion={visit.patientName} onLinked={() => void load()}
              onOpenFile={async () => {
                if (!(await send(payload()))) return;
                const patientId = await openPatientFile(visit.id);
                if (patientId) window.location.href = `/patients/${patientId}?tab=today`;
              }} />
          ) : null}

          {visit.ortho ? (
            <div className="mb-2 rounded-xl border border-navy-200 bg-navy-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-extrabold text-navy-900">
                  مريض تقويم · {orthoPhaseLabel(visit.ortho.phase)}
                </span>
                {/* السلكان موسومان: «014 / 012» وحدها لا تقول أيّهما العلوي. */}
                <span className="flex items-center gap-2 text-sm font-extrabold text-navy-900">
                  {visit.ortho.upperWire || visit.ortho.lowerWire ? (
                    <>
                      <span>علوي <span dir="ltr">{visit.ortho.upperWire ?? "—"}</span></span>
                      <span className="text-navy-300">·</span>
                      <span>سفلي <span dir="ltr">{visit.ortho.lowerWire ?? "—"}</span></span>
                    </>
                  ) : "بلا سلك بعد"}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-navy-800">
                {visit.ortho.lastAdjustment
                  ? `${sinceText(visit.ortho.daysSinceLast)}${visit.ortho.lastDone ? ` — ${visit.ortho.lastDone}` : ""}`
                  : "لا شدّات مسجّلة بعد"}
                {visit.ortho.elasticNote ? ` · مطاطات: ${visit.ortho.elasticNote}` : ""}
              </p>
              {visit.ortho.visitAdjustmentId !== null ? (
                <p className="mt-1 text-[11px] font-bold text-emerald-800">✓ سُجّلت شدّة هذه الزيارة</p>
              ) : visit.status === "open" && orthoSession && canEditWork ? (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="text-[10px] font-bold text-slate-600">
                    السلك العلوي
                    <input value={orthoSession.upperWire} dir="ltr" aria-label="السلك العلوي لهذه الشدّة"
                      onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, upperWire: event.target.value }); }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono" />
                  </label>
                  <label className="text-[10px] font-bold text-slate-600">
                    السلك السفلي
                    <input value={orthoSession.lowerWire} dir="ltr" aria-label="السلك السفلي لهذه الشدّة"
                      onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, lowerWire: event.target.value }); }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono" />
                  </label>
                  <label className="text-[10px] font-bold text-slate-600">
                    المطاطات
                    <select value={orthoSession.elastics} aria-label="مطاطات هذه الشدّة"
                      onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, elastics: event.target.value as ElasticClass }); }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
                      {(Object.keys(ELASTIC_LABEL) as ElasticClass[]).map((value) => (
                        <option key={value} value={value}>{ELASTIC_LABEL[value]}</option>
                      ))}
                    </select>
                  </label>
                  {orthoSession.elastics !== "none" && (
                    <label className="col-span-2 text-[10px] font-bold text-slate-600 sm:col-span-3">
                      وصف المطاطات (المقاس، القوة، الجهة، ساعات اللبس)
                      <input value={orthoSession.elasticNote} aria-label="وصف مطاطات هذه الشدّة"
                        onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, elasticNote: event.target.value }); }}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                    </label>
                  )}
                  <label className="col-span-2 text-[10px] font-bold text-slate-600">
                    ما نُفّذ
                    <input value={orthoSession.done} aria-label="ما نُفّذ في الشدّة"
                      onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, done: event.target.value }); }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                  </label>
                  <label className="text-[10px] font-bold text-slate-600">
                    القادمة بعد (أسابيع)
                    <input value={orthoSession.nextWeeks} inputMode="numeric" dir="ltr" aria-label="أسابيع حتى الشدّة القادمة"
                      onChange={(event) => { if (canEditOwnedDraft()) setOrthoSession({ ...orthoSession, nextWeeks: event.target.value }); }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                  </label>
                  <p className="col-span-2 text-[10px] text-navy-700 sm:col-span-3">
                    تُحفظ الشدّة مع توقيع الزيارة — مرةً واحدة مهما تكرّر الضغط.
                    <button type="button" onClick={() => { if (canEditOwnedDraft()) setOrthoSession(null); }}
                      className="ms-2 font-bold text-slate-600 underline">إلغاء</button>
                  </p>
                </div>
              ) : visit.status === "open" && canEditWork ? (
                <button type="button"
                  disabled={busy || !!writeHold || suspended}
                  onClick={() => { if (!canEditOwnedDraft()) return; setOrthoSession({
                    upperWire: visit.ortho?.suggestedUpper ?? visit.ortho?.upperWire ?? "",
                    lowerWire: visit.ortho?.suggestedLower ?? visit.ortho?.lowerWire ?? "",
                    elastics: (visit.ortho?.elastics as ElasticClass | null) ?? "none",
                    elasticNote: visit.ortho?.elasticNote ?? "", done: "", nextWeeks: String(visit.ortho?.nextWeeks ?? 4),
                  }); }}
                  className="mt-1 rounded-lg border border-navy-300 bg-white px-3 py-1 text-[11px] font-bold text-navy-900 hover:bg-navy-100">
                  + شدّة هذه الزيارة (تُحفظ مع التوقيع)
                </button>
              ) : null}
              {(visit.ortho.visitAdjustmentId !== null || orthoSession !== null) && (
                <p className="mt-1 text-[11px] font-bold text-navy-800">
                  {visit.ortho.adjustmentBillingClass === "LEGACY_INCLUDED"
                    ? "شدّة مشمولة بالعلاج السابق؛ لا فاتورة جديدة للشدّة نفسها."
                    : visit.ortho.adjustmentBillingClass === "INCLUDED"
                      ? "شدّة مشمولة باتفاق الأقساط؛ لا فاتورة مستقلة للشدّة."
                      : "الشدّة خارج العقد — لا فاتورة تلقائية. فوترها بإضافة خدمة «شدّة تقويم»، أو اخترها «بلا رسوم» بسبب، أو تبقى معلّقة لقرار لاحق."}
                </p>
              )}
              {visit.status === "open" && canEditWork && visit.ortho.adjustmentBillingClass === "OUTSIDE_CONTRACT"
                && (visit.ortho.visitAdjustmentId !== null || orthoSession !== null) ? (
                <div className="mt-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px]">
                  <label className="flex items-center gap-1.5 font-bold text-rose-900">
                    <input type="checkbox" checked={noChargeAdjustment} onChange={(event) => { if (canEditOwnedDraft()) setNoChargeAdjustment(event.target.checked); }} />
                    بلا رسوم لهذه الشدّة
                  </label>
                  {noChargeAdjustment ? (
                    <input value={noChargeReason} onChange={(event) => { if (canEditOwnedDraft()) setNoChargeReason(event.target.value); }}
                      aria-label="سبب بلا رسوم للشدّة" placeholder="السبب — مثل: شدّة تعويضية بعد كسر حاصرة"
                      className="mt-1 w-full rounded-lg border border-rose-200 bg-white px-2 py-1 text-xs" />
                  ) : null}
                </div>
              ) : null}
              <a href={`/patients/${visit.patientId}?tab=ortho`}
                className="mt-1 ms-2 inline-block text-[11px] font-bold text-navy-800 underline decoration-navy-300 underline-offset-4">
                ملف التقويم
              </a>
            </div>
          ) : null}

          {visit.planWarning ? (
            <p role="alert" className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
              {visit.planWarning}
            </p>
          ) : visit.planItemsMatched > 0 ? (
            <p className="mb-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-800">
              يشطب هذا العمل {visit.planItemsMatched} من بنود
              {visit.planTitle ? ` «${visit.planTitle}»` : " خطة العلاج"}.
            </p>
          ) : null}

        <div id="visit-sign" className="flex scroll-mt-4 flex-wrap gap-2">
          <button onClick={() => void send(payload())} disabled={busy || !!writeHold || readDenied || suspended}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-navy-800 disabled:opacity-40">
            احفظ بلا توقيع
          </button>
          <button
            onClick={async () => {
              // الحفظ ثم المراجعة: توقيعٌ يترك ما كُتب في الشاشة غير محفوظ يفقد العمل.
              const saved = await send(payload());
              if (!saved || !currentOwner() || saved.sequence !== loadSequence.current || saved.visit.status !== "open") return;
              /* (VISIT-2) المريض الجديد بلا ملف: يُفتح ملفّه أولًا ثم يكمل الإنهاء من «زيارة اليوم»
                 في ملفّه — فيأتي بعد التوقيع الشبّاك (التحصيل وحجز الجلسة القادمة) ويبقى الملف مفتوحًا. */
              if (saved.visit.patientId === null) {
                const patientId = await openPatientFile(saved.visit.id);
                if (patientId) window.location.href = `/patients/${patientId}?tab=today&review=1`;
                return;
              }
              setReviewOpen(true);
            }}
            disabled={busy || !!writeHold || readDenied || suspended}
            className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
            مراجعة وإنهاء الزيارة
          </button>
        </div>
        </>
      ) : (
        <p className="text-[11px] font-semibold text-slate-400">التوثيق السريري يُكتب من الطبيب.</p>
      )}

      {!signed && canWrite ? (
        <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-400">
          الإنهاء يوقّع الزيارة ويعالج إجراءاتها المالية إن وُجدت، وينجز الجلسات، ويحدّث
          المخطط السني، ويقترح الجلسة القادمة في عملية واحدة. التوثيق السريري وحده لا ينشئ رسومًا. وبعده لا تُعدَّل
          الزيارة — التصحيح بملحق يحمل كاتبه ووقته.
        </p>
      ) : null}

      {/* شاشة المراجعة والإنهاء (المواصفة §٢١): ما نُفّذ، وما لم يُنفّذ، والاستحقاق،
          والجلسة القادمة — ثم تأكيدٌ واحد لا يفاجئ أحدًا برقم. */}
      {reviewOpen ? (
        <div role="dialog" aria-label="مراجعة وإنهاء الزيارة"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setReviewOpen(false)}>
          <section className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-navy-800 bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}>
            <header className="mb-3">
              <h3 className="text-sm font-extrabold text-navy-900">مراجعة وإنهاء الزيارة</h3>
              <p className="text-[11px] text-slate-500">{visit.patientName}</p>
            </header>

            <dl className="space-y-2 text-xs">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <dt className="mb-1 font-extrabold text-emerald-900">تم اليوم</dt>
                {doneToday.length > 0 ? (
                  <dd className="space-y-0.5">
                    {doneToday.map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex justify-between gap-2 text-emerald-900">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""}</span>
                          <span className="font-bold">{formatMoney(amount, draft.currency)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : (
                  <dd className="text-slate-500">{drafts.length === 0
                    ? "لا توجد إجراءات في هذه الزيارة. يمكن توقيع توثيق سريري فعلي دون إنشاء فاتورة."
                    : "لا إجراءات من الخطة — ما يلي إجراءاتٌ حرّة."}</dd>
                )}
                {drafts.length > doneToday.length ? (
                  <dd className="mt-1 space-y-0.5">
                    {drafts.filter((draft) => draft.planItemId === null).map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex justify-between gap-2 text-slate-700">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""} (غير مخطَّط)</span>
                          <span className="font-bold">{formatMoney(amount, draft.currency)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : null}
              </div>

              {savedSpecialtyReview}

              {notDoneToday.length > 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <dt className="mb-1 font-extrabold text-slate-700">لم يُنفّذ بعد</dt>
                  <dd className="space-y-0.5 text-slate-600">
                    {notDoneToday.slice(0, 6).map((item) => (
                      <p key={item.planItemId}>
                        {item.serviceName}{item.toothCode ? ` — سن ${item.toothCode}` : ""}
                        {item.sessionCount > 1 ? ` (جلسة ${item.doneSessions + 1} من ${item.sessionCount})` : ""}
                      </p>
                    ))}
                    {notDoneToday.length > 6 ? <p>و{notDoneToday.length - 6} أخرى…</p> : null}
                  </dd>
                </div>
              ) : null}

              {unmetInVisit.length > 0 ? (
                <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  <dt className="font-extrabold">بنودٌ تتطلب ما لم يكتمل بعد</dt>
                  <dd className="space-y-1">
                    {unmetInVisit.map((line) => <p key={line}>⚠️ {line}</p>)}
                    <textarea value={overrideReason} onChange={(event) => { if (canEditOwnedDraft()) setOverrideReason(event.target.value); }} maxLength={300}
                      rows={2} aria-label="سبب المتابعة" placeholder="سبب المتابعة الآن (يُسجَّل في سجل التدقيق)"
                      className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-2 py-1 text-sm text-slate-800" />
                  </dd>
                </div>
              ) : null}

              {ownerlessPricedWork ? (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-800">
                  <dt className="font-extrabold">لم يُحدَّد الطبيب المعالج</dt>
                  <dd>اختره من «الطبيب المعالج» قبل الإنهاء — العمل يُنسب إليك فقط إن كنت الطبيب الموقِّع، وإلا يُرفض التوقيع كي لا تضيع عمولته.</dd>
                </div>
              ) : null}

              {serverZeroDue ? (
                <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-3" data-testid="no-additional-due">
                  <dt className="flex items-center justify-between font-extrabold text-emerald-900">
                    <span>الاستحقاق المالي اليوم</span>
                    <span className="text-lg font-black">0</span>
                  </dt>
                  <dd className="mt-1 font-bold text-emerald-800">لا يوجد استحقاق إضافي على المريض لهذه الزيارة</dd>
                  {billingPreview?.zeroReason ? (
                    <dd className="mt-0.5 text-[11px] font-semibold text-emerald-700">السبب: {billingPreview.zeroReason}</dd>
                  ) : null}
                </div>
              ) : (
              <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-3">
                <dt className="font-extrabold text-amber-900">الاستحقاق المالي الناتج</dt>
                {/* (TD-05 second owner review — Finding 7) المراجعة أيضًا لا
                    تعرض إجماليًا رقميًا واحدًا عبر عملتين — مجموعان + تحذير. */}
                <dd className="text-lg font-black text-amber-900" data-testid="currency-subtotals">
                  {mixedCurrencies ? (
                    <span className="flex flex-col items-end">
                      {currencyTotals.map((bucket) => (
                        <span key={bucket.currency}>
                          {formatMoney(bucket.totalMinor, bucket.currency)}
                        </span>
                      ))}
                      <span className="text-[10px] font-bold text-danger-700" data-testid="mixed-currency-warning">
                        عملتان في زيارةٍ واحدة — التوقيع سيرفضها: افصل الإجراءات
                      </span>
                    </span>
                  ) : serverDue ? formatMoney(serverDue.minor, serverDue.currency) : formatMoney(total, singleCurrency)}
                </dd>
              </div>
              )}

              <div className="rounded-xl border border-navy-200 bg-navy-50 p-3">
                <dt className="font-extrabold text-navy-900">خطة الزيارة القادمة</dt>
                <dd className="mt-0.5 text-navy-800">
                  {notes.nextPlan?.trim()
                    ? notes.nextPlan
                    : notDoneToday[0]
                      ? `${notDoneToday[0].serviceName}${notDoneToday[0].toothCode ? ` — سن ${notDoneToday[0].toothCode}` : ""}${notDoneToday[0].sessionCount > 1 ? ` (جلسة ${notDoneToday[0].doneSessions + 1} من ${notDoneToday[0].sessionCount})` : ""}`
                      : "تُقترح تلقائيًا من الجلسات المتبقّية عند الإنهاء"}
                  {notDoneToday[0] ? ` · مدة مقترحة 30 دقيقة` : ""}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => setReviewOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600">
                رجوع — أكمل العمل
              </button>
              <button type="button" onClick={() => void sign()}
                disabled={busy || !!writeHold || readDenied || suspended || structuredClinical?.status !== "ready" || structuredClinical.signedAt !== null}
                className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
                {busy
                  ? "جارٍ الإنهاء…"
                  : mixedCurrencies || billingPreview?.mixedCurrencies
                    ? "تأكيد إنهاء الزيارة — عملتان: فاصل الإجراءات أولًا"
                    : serverZeroDue
                      ? "✓ وقّع الزيارة — دون استحقاق إضافي"
                      : serverDue
                        ? `وقّع الزيارة وأنشئ استحقاق ${formatMoney(serverDue.minor, serverDue.currency)}`
                        : `تأكيد إنهاء الزيارة${total > 0 ? ` — ${formatMoney(total, singleCurrency)}` : ""}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* وصفة طبية من مساحة العمل (من عمل الوكيل المساعد): التشخيص المكتوب
          والطبيب المختار يُعبّآن تلقائيًا — وصفةٌ من سياق الزيارة نفسها. */}
      <PrescriptionModal
        key={`${visit.patientId ?? "unlinked"}:${visit.id}`}
        visitId={visit.patientId ? visit.id : undefined}
        isOpen={rxOpen}
        onClose={() => setRxOpen(false)}
        patientId={visit?.patientId ?? undefined}
        patientName={visit?.patientName ?? ""}
        /* التنبيه الطبي والهاتف يمرّان ليُفحص أمان الدواء داخل الزيارة نفسها —
           فحص السلامة بلا بيانات المريض نصٌّ فارغ (P0.10). */
        medicalAlert={patientContext?.medicalAlert ?? null}
        patientPhone={patientContext?.phone ?? null}
        defaultDiagnosis={notes.diagnosis}
        defaultDoctorName={doctors.find((d) => d.id === doctorId)?.name ?? ""}
      />

      <PostOpModal
        isOpen={postOpOpen}
        onClose={() => setPostOpOpen(false)}
        patientId={visit?.patientId ?? 0}
        patientName={visit?.patientName ?? ""}
        initialTreatmentText={notes.treatmentDone || notes.diagnosis || ""}
      />
    </div>
  );
}

function Field({ label, value, onChange, disabled, auto = false, hint, phrases = [], onPhrase }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean;
  /** (VISIT-1) مُلئ تلقائيًا من الموعد أو الخطة — يُوسَم حتى يعدّله الطبيب. */
  auto?: boolean;
  hint?: string;
  /** (VISIT-1) عباراتٌ سريعة تُضاف بنقرة (من الإعدادات). */
  phrases?: string[];
  onPhrase?: (phrase: string) => void;
}) {
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold text-slate-500">
          {label}
          {auto ? <span className="mr-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">✨ تلقائي — عدّله إن لزم</span> : null}
        </span>
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={2} disabled={disabled}
          className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-brand-blue disabled:bg-slate-50 disabled:text-slate-500 ${
            auto ? "border-amber-200 bg-amber-50/40" : "border-slate-200"}`} />
      </label>
      {hint ? <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{hint}</p> : null}
      {phrases.length > 0 && onPhrase ? (
        <div className="mt-1 flex flex-wrap gap-1" aria-label={`عبارات سريعة — ${label}`}>
          {phrases.map((phrase) => (
            <button key={phrase} type="button" disabled={disabled} onClick={() => onPhrase(phrase)}
              className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-navy-800 hover:text-navy-900">
              + {phrase}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * (VISIT-1) تسلسل الزيارة ظاهرًا: الشكوى ← الفحص والتشخيص ← الإجراءات ← المراجعة والتوقيع.
 * كل خطوةٍ تُعلَّم حين تكتمل، والنقر ينزل إلى قسمها.
 */
export function VisitSteps({ steps }: { steps: { id: string; label: string; done: boolean }[] }) {
  const current = steps.findIndex((step) => !step.done);
  return (
    <ol className="mb-3 grid grid-cols-4 gap-1" aria-label="خطوات الزيارة">
      {steps.map((step, index) => (
        <li key={step.label}>
          <a href={`#${step.id}`} aria-current={index === current ? "step" : undefined}
            className={`block rounded-xl border px-1.5 py-1.5 text-center text-[11px] font-bold leading-4 ${
              step.done ? "border-success-300 bg-success-50 text-success-700"
                : index === current ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-500"}`}>
            {step.done ? "✓ " : `${index + 1}. `}{step.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * يربط زيارةً بملفٍّ قائم قبل التوقيع.
 *
 * لا مطابقة صامتة بالاسم: «محمد أحمد» اسمُ رجلين، ودمجُ ملفَّي شخصين يخلط تاريخين
 * طبيّين — وهو أسوأ من تكرار ملفٍّ واحد يُدمج لاحقًا. فالبرنامج يعرض، والطبيب يقرّر.
 */
function LinkPatient({ visitId, suggestion, onLinked, onOpenFile }: {
  visitId: number; suggestion: string; onLinked: () => void; onOpenFile: () => Promise<void>;
}) {
  const [term, setTerm] = useState(suggestion);
  const [matches, setMatches] = useState<{ id: number; patientNumber: string; fullName: string; phone: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const text = term.trim();
    if (text.length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/patients?q=${encodeURIComponent(text)}`, { cache: "no-store" });
          if (!response.ok) return;
          const payload = await response.json();
          setMatches(Array.isArray(payload) ? payload.slice(0, 5) : []);
        } catch {
          // البحث مساعدةٌ لا شرط — تعذّره لا يمنع التوقيع.
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [term, open]);

  const link = async (patientId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link", patientId }),
      });
      if (response.ok) { setOpen(false); onLinked(); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
      <p className="text-xs font-bold text-amber-900">
        مريض جديد بلا ملف — افتح له ملفًّا الآن ليُكمل الطبيب كل شيء من ملفّه: الإجراءات وطلب المعمل
        والوصفة، ثم الإنهاء والتحصيل وحجز الجلسة القادمة.
        {open ? "" : " وإن كان مسجّلًا من قبل فاربطه بملفّه."}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy}
          onClick={async () => { setBusy(true); try { await onOpenFile(); } finally { setBusy(false); } }}
          className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-extrabold text-white disabled:opacity-40">
          افتح له ملفًّا الآن
        </button>
        {open ? null : (
          <button type="button" onClick={() => setOpen(true)}
            className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-bold text-amber-800">
            ابحث عن ملفّه القائم
          </button>
        )}
      </div>

      {open ? (
        <div className="mt-2">
          <input value={term} onChange={(event) => setTerm(event.target.value)}
            aria-label="ابحث عن ملف المريض" autoFocus
            className="mb-1.5 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs" />
          {matches.length === 0 ? (
            <p className="text-[11px] text-amber-800">لا ملفّات مطابقة — افتح له ملفًّا جديدًا.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {matches.map((match) => (
                <li key={match.id}>
                  <button type="button" disabled={busy} onClick={() => void link(match.id)}
                    className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-bold text-navy-800 disabled:opacity-40">
                    {match.fullName}
                    <span className="mr-1.5 font-normal text-slate-500">
                      {match.patientNumber}{match.phone ? ` · ${match.phone}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
