"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isClinicalSignResult } from "@/lib/clinical-sign-result";
import { CLINIC_BASE_CURRENCY, formatAmount, formatMoney, isCurrency, parseAmount, type Currency } from "@/lib/money";
import { isValidTooth, normalizeSurfaces, toothName } from "@/lib/dental";
import { LAB_STATUS_LABEL, type LabOrderStatus } from "@/lib/lab";
import { ToothField } from "./ToothPicker";
import { visitTotal, type ProcedureLine } from "@/lib/clinical";
import { PrescriptionModal } from "./PrescriptionModal";
import { PostOpModal } from "./PostOpModal";
import { PatientDiagnosis } from "./PatientDiagnosis";
import {
  BILLING_RULE_LABEL, labWorkForCategory, priceForSession, sessionPriceNote,
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
import { VisitPhraseField as Field } from "./VisitPhraseField";
import { VisitPlanRequirements } from "./VisitPlanRequirements";
import { VisitMaterials } from "./VisitMaterials";
import { QuickServicePicker } from "./QuickServicePicker";
import { hasUnresolvedClinicalFinance, hasVerifiedClinicalCoverage, visitSignatureBlock } from "./invoice-clinical-readiness";

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
  procedures: ProcedureLine[]; totalMinor: number;
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
    historicalProgressUnknown?: boolean;
  }[];
  outstanding: {
    planItemId: number; serviceId: number | null; planTitle: string; serviceName: string;
    toothCode: number | null; surfaces?: string | null; billingRule: BillingRule;
    caseId?: number | null; caseSite?: string | null; origin?: string;
    originInvoiceId?: number | null; billedInvoiceId?: number | null; billingStatus?: string;
    clinicalConsentRecorded?: boolean; financialReviewRequired?: boolean; prebilled?: boolean;
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
    planItemId: number; procedureId: number;
    sessionIndex: number; sessionCount: number;
    priceMinor: number; note: string;
    financialReviewRequired?: boolean; clinicalConsentRecorded?: boolean;
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

/** A completed POST alone does not prove that its subsequent read contains the saved draft. */
function matchesSubmittedVisit(loaded: Visit, body: Record<string, unknown>): boolean {
  const noteKeys: NoteKey[] = ["chiefComplaint", "examination", "diagnosis", "treatmentDone", "nextPlan"];
  if (noteKeys.some((key) => (loaded[key] ?? "") !== (typeof body[key] === "string" ? (body[key] as string).trim().slice(0, key === "chiefComplaint" || key === "nextPlan" ? 500 : 2000) : ""))
    || loaded.doctorId !== body.doctorId
    || (loaded.billingCurrency ?? CLINIC_BASE_CURRENCY) !== body.billingCurrency
    || !Array.isArray(body.procedures) || loaded.procedures.length !== body.procedures.length) return false;
  const identity = (row: Record<string, unknown>) => JSON.stringify([
    row.serviceId, row.toothCode ?? null,
    normalizeSurfaces(typeof row.surfaces === "string" ? row.surfaces : null),
    row.doctorId ?? null, row.planItemId ?? null,
  ]);
  return loaded.procedures.every((row, index) => {
    const submitted = (body.procedures as unknown[])[index];
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) return false;
    const requested = submitted as Record<string, unknown>;
    if (identity(row as unknown as Record<string, unknown>) !== identity(requested)) return false;
    if (row.planItemId != null) {
      // Linked quantities/prices belong to the server's current session rules.
      // Adopt the authorized canonical estimate; do not recreate pricing here.
      // Identity and every clinician-owned note/provider/currency still match.
      return row.quantity === 1 && Number.isSafeInteger(row.unitPriceMinor) && row.unitPriceMinor >= 0;
    }
    return row.quantity === Math.max(1, Math.round(Number(requested.quantity) || 1))
      && row.unitPriceMinor === Math.max(0, Math.round(Number(requested.unitPriceMinor) || 0));
  });
}

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

export function ClinicalVisit({ visitId, onSigned, autoReview = false, expectedPatientId, onNavigationGuardChange, onPreviousVisitReferenceChange }: {
  visitId: number;
  expectedPatientId?: number;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
  /** Presentation-only: lets the enclosing workspace omit the same visible reference. */
  onPreviousVisitReferenceChange?: (previousVisitId: number | null) => void;
  onSigned?: (result: VisitSignResult) => void;
  /** (VISIT-2) افتح «مراجعة وإنهاء الزيارة» مباشرةً بعد التحميل — حين يصل الطبيب إلى ملف
   *  المريض الجديد الذي فُتح له للتوّ من زيارته ليكمل الإنهاء هناك. */
  autoReview?: boolean;
}) {
  // (TD-05) الأساس دستوري من الكود.
  const base: Currency = CLINIC_BASE_CURRENCY;
  const session = useSession();
  /* (P0-F) المساعد السريري يُكمل الملاحظات ويُنهي الزيارة باسمه؛ الإجراءات وأسعارها والطبيب المعالج
     للطبيب والمدير وحدهما — والخادم يرفض غير ذلك صراحةً. */
  const canWrite = isAdmin(session?.role) || session?.role === "doctor" || session?.role === "assistant";
  const canEditWork = isAdmin(session?.role) || session?.role === "doctor";

  // A retained component may receive another visit or principal. A fresh token
  // also distinguishes A→B→A, so identity equality cannot revive old requests.
  const ownerKey = JSON.stringify([visitId, expectedPatientId ?? null, session?.username ?? null,
    session?.role ?? null, session?.permissions ?? null]);
  const [owner, setOwner] = useState({ key: ownerKey, generation: 0 });
  if (owner.key !== ownerKey) setOwner({ key: ownerKey, generation: owner.generation + 1 });
  const liveOwner = useRef<typeof owner | null>(owner);
  const loadSequence = useRef(0);
  const lastAppliedOwner = useRef<typeof owner | null>(null);
  const command = useRef<{ owner: typeof owner } | null>(null);
  const [loadedOwner, setLoadedOwner] = useState<typeof owner | null>(null);
  // A route/principal owner is not permission to reuse an old accepted clinical read.
  // Clear synchronously when any refresh begins; stale event closures cannot sign during it.
  const acceptedReadOwner = useRef<typeof owner | null>(null);
  // An accepted signature is a receipt, never another read/write grant. Keep
  // its one-way status across retries, but never display it after access denial.
  const confirmedSignOwner = useRef<typeof owner | null>(null);
  const [deniedOwner, setDeniedOwner] = useState<typeof owner | null>(null);
  useLayoutEffect(() => {
    liveOwner.current = owner;
    return () => {
      if (liveOwner.current === owner) liveOwner.current = null;
      loadSequence.current += 1;
    };
  }, [owner]);
  const currentOwner = useCallback(() => owner.key === ownerKey && liveOwner.current === owner, [owner, ownerKey]);

  const [visit, setVisit] = useState<Visit | null>(null);
  const ownsVisit = loadedOwner === owner && owner.key === ownerKey && visit?.id === visitId;
  const [dirty, setDirty] = useState(false);
  const draftForLeave = useRef({ owner, dirty: false });
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
  const draftSnapshot = useRef({ owner, notes, drafts, doctorId, visitCurrency });
  useLayoutEffect(() => {
    draftSnapshot.current = { owner, notes, drafts, doctorId, visitCurrency };
  }, [owner, notes, drafts, doctorId, visitCurrency]);
  /* (CASE-1) شدّة التقويم في هذه الزيارة — تُرسل مع التوقيع وتُكتب في معاملته، مرةً واحدة. */
  const [orthoSession, setOrthoSession] = useState<{
    upperWire: string; lowerWire: string; elastics: ElasticClass | ""; elasticNote: string; done: string; nextWeeks: string;
  } | null>(null);
  /* (VISIT-1) ما مُلئ تلقائيًا — يُوسَم «تلقائي» حتى يلمسه الطبيب. */
  const [autoFilled, setAutoFilled] = useState<Set<NoteKey | "doctor">>(new Set());
  /* آخر نصٍّ ولّدته الإجراءات في «ما نُفّذ» — ما دام الحقل عليه (أو فارغًا) يتبع الإجراءات. */
  const lastAutoTreatment = useRef("");
  // Explicitly authored text, including an intentional blank, survives reads.
  // A later local procedure edit may resume auto-fill only while it is blank.
  const explicitTreatmentOwner = useRef<typeof owner | null>(null);
  const phrases = {
    chiefComplaint: parsePhraseList(useSetting("clinical.phrases_complaint")),
    examination: parsePhraseList(useSetting("clinical.phrases_exam")),
    diagnosis: parsePhraseList(useSetting("clinical.phrases_diagnosis")),
    nextPlan: parsePhraseList(useSetting("clinical.phrases_next")),
  };
  const [addendum, setAddendum] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorOwner, setErrorOwner] = useState<typeof owner | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!reviewOpen || !ownsVisit || typeof document === "undefined") return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reviewPanel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [reviewOpen, ownsVisit, owner]);
  const handleReviewKeyDown = (event: import("react").KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy && currentOwner()) setReviewOpen(false);
    }
    if (event.key !== "Tab" || !reviewPanel.current) return;
    const controls = Array.from(reviewPanel.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
    ));
    const first = controls[0]; const last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); reviewPanel.current.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === reviewPanel.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === reviewPanel.current)) {
      event.preventDefault(); first.focus();
    }
  };
  // Reference-only identity also retires same-visit case A→B→A and leaving
  // explicit follow-up mode. It never resets the clinical notes or adjustment.
  const referenceKey = JSON.stringify([owner.key, owner.generation,
    ownsVisit ? visit?.patientId : null, ownsVisit ? visit?.ortho?.caseId : null,
    ownsVisit && visit?.status !== "signed" && Boolean(visit?.ortho && (orthoSession || visit.ortho.visitAdjustmentId != null))]);
  const [referenceOwner, setReferenceOwner] = useState({ key: referenceKey, generation: 0, active: false });
  if (referenceOwner.key !== referenceKey) setReferenceOwner({ key: referenceKey, generation: referenceOwner.generation + 1, active: false });
  useLayoutEffect(() => {
    referenceOwner.active = true;
    return () => { referenceOwner.active = false; };
  }, [referenceOwner]);
  const [referenceOpen, setReferenceOpen] = useState<{ owner: typeof referenceOwner; open: boolean } | null>(null);
  /* (P3) منتقي الدليل السريع لإضافة إجراءٍ حرّ — نفس مسار الإضافة من القائمة. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const servicePickerTrigger = useRef<HTMLButtonElement>(null);
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
    if (!reviewOpen || !ownsVisit) { setBillingPreview(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/visits/${visitId}/billing-preview`, { cache: "no-store" });
        if (!response.ok || cancelled || !currentOwner()) return;
        const preview = await response.json() as BillingPreview;
        if (!cancelled && currentOwner()) setBillingPreview(preview);
      } catch {
        // بلا معاينة تبقى المراجعة كما كانت — والتوقيع يقرر في الخادم على أي حال.
      }
    })();
    return () => { cancelled = true; };
  }, [reviewOpen, visitId, ownsVisit, currentOwner]);
  /* الوصفة الطبية من مساحة العمل (من عمل الوكيل المساعد): التشخيص والطبيب
     يُعبّآن تلقائيًا مما كُتب في الزيارة — الطبيب يكتب التشخيص مرة واحدة. */
  const [rxOpen, setRxOpen] = useState(false);
  const [postOpOpen, setPostOpOpen] = useState(false);
  // Prescription context is a separate, read-only lifetime. Opening/reopening
  // refreshes it without reloading the visit or replacing any clinical/Rx draft.
  // Token identity retires patient/visit/principal/permissions A→B→A and even
  // same-patient close→reopen responses, before and after body decoding.
  const contextPatientId = ownsVisit && typeof visit?.patientId === "number"
    && Number.isSafeInteger(visit.patientId) && visit.patientId > 0 ? visit.patientId : null;
  const patientContextKey = JSON.stringify([owner.key, owner.generation, contextPatientId, rxOpen]);
  const [patientContextOwner, setPatientContextOwner] = useState({ key: patientContextKey, active: false });
  if (patientContextOwner.key !== patientContextKey) setPatientContextOwner({ key: patientContextKey, active: false });
  useLayoutEffect(() => {
    patientContextOwner.active = true;
    return () => { patientContextOwner.active = false; };
  }, [patientContextOwner]);
  const [patientContext, setPatientContext] = useState<
    | { owner: typeof patientContextOwner; status: "ready"; medicalAlert: string | null; phone: string | null }
    | { owner: typeof patientContextOwner; status: "unavailable" }
    | null
  >(null);
  const ownedPatientContext = patientContextOwner.key === patientContextKey
    && patientContext?.owner === patientContextOwner ? patientContext : null;
  const readyPatientContext = ownedPatientContext?.status === "ready" ? ownedPatientContext : null;
  const patientContextStatus = !contextPatientId ? "unavailable" : ownedPatientContext?.status ?? "loading";

  useEffect(() => {
    const patientId = contextPatientId;
    if (!rxOpen || !patientId || !ownsVisit) return;
    const controller = new AbortController();
    const stillCurrent = () => !controller.signal.aborted && patientContextOwner.active && currentOwner();
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}`, { cache: "no-store", signal: controller.signal });
        if (!stillCurrent()) return;
        if (!response.ok) throw new Error("Patient context unavailable");
        const payload: unknown = await response.json();
        if (!stillCurrent()) return;
        const patient = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).patient : null;
        if (!patient || typeof patient !== "object" || Array.isArray(patient)) throw new Error("Invalid patient context");
        const record = patient as Record<string, unknown>;
        // Missing/malformed fields are unknown, never a verified empty alert.
        if (record.id !== patientId
          || !(record.medicalAlert === null || typeof record.medicalAlert === "string")
          || !(record.phone === null || typeof record.phone === "string")) throw new Error("Invalid patient context");
        setPatientContext({ owner: patientContextOwner, status: "ready", medicalAlert: record.medicalAlert, phone: record.phone });
      } catch {
        if (stillCurrent()) setPatientContext({ owner: patientContextOwner, status: "unavailable" });
      }
    })();
    return () => { controller.abort(); };
  }, [contextPatientId, ownsVisit, rxOpen, patientContextOwner, currentOwner]);

  const load = useCallback(async (requiredStatus?: Visit["status"], orthodonticDraft = false,
    submitted?: { body: Record<string, unknown>; snapshot: typeof draftSnapshot.current }) => {
    if (!currentOwner()) return false;
    acceptedReadOwner.current = null;
    const sequence = ++loadSequence.current;
    const stillCurrent = () => currentOwner() && sequence === loadSequence.current;
    // Only locally authored, owner-safe text may be published by a failed read.
    let failureMessage = "تعذّر تحميل الزيارة الحالية. أعد المحاولة.";
    const invalid = (message: string): never => { failureMessage = message; throw new Error(message); };
    try {
      // Check the authoritative status before reading its body or waiting for
      // auxiliary catalogues: a stalled 403 body must not retain old clinical authority.
      const visitResponse = await fetch(`/api/visits/${visitId}/clinical`, { cache: "no-store" });
      if (!stillCurrent()) return false;
      if (!visitResponse.ok) {
        if (visitResponse.status === 401 || visitResponse.status === 403 || visitResponse.status === 404) {
          setDeniedOwner(owner);
          invalid("تعذّر تأكيد صلاحية قراءة الزيارة الحالية. أعد التحميل بعد التحقق من الوصول.");
        }
        invalid(failureMessage);
      }
      const [payload, serviceResponse, partyResponse] = await Promise.all([
        visitResponse.json(), fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      const [catalog, parties] = await Promise.all([
        serviceResponse.ok ? serviceResponse.json() : null,
        partyResponse.ok ? partyResponse.json() : null,
      ]);
      if (!stillCurrent()) return false;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid("بيانات الزيارة غير مكتملة. أعد تحميلها قبل التوثيق.");
      const loaded = payload as Visit;
      if (loaded.id !== visitId || (expectedPatientId !== undefined && loaded.patientId !== expectedPatientId)) {
        invalid("بيانات الزيارة لا تطابق السياق الحالي. حدّث الزيارة قبل التوثيق.");
      }
      const expectedStatus = confirmedSignOwner.current === owner ? "signed" : requiredStatus;
      if (expectedStatus && loaded.status !== expectedStatus) invalid("تعذّر تأكيد حالة الزيارة بعد الحفظ. أعد تحميلها.");
      const recordList = (value: unknown) => Array.isArray(value)
        && value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
      const nullableText = (value: unknown) => value === null || typeof value === "string";
      if ((loaded.status !== "open" && loaded.status !== "signed")
        || typeof loaded.patientName !== "string"
        || (loaded.patientId !== null && (!Number.isSafeInteger(loaded.patientId) || loaded.patientId <= 0))
        || [loaded.chiefComplaint, loaded.examination, loaded.diagnosis, loaded.treatmentDone, loaded.nextPlan].some((value) => !nullableText(value))
        || !recordList(loaded.procedures) || !recordList(loaded.outstanding)
        || !recordList(loaded.sessionPricing) || !recordList(loaded.labOrders)
        || (loaded.activeCases != null && !recordList(loaded.activeCases))
        || (catalog !== null && !recordList(catalog))
        || (parties !== null && !recordList(Array.isArray(parties) ? parties : parties?.balances))) {
        invalid("بيانات الزيارة غير مكتملة. أعد تحميلها قبل التوثيق.");
      }
      if (loaded.procedures.some((line) => !Number.isSafeInteger(line.serviceId) || line.serviceId <= 0
        || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPriceMinor) || line.unitPriceMinor < 0)) {
        invalid("بيانات إجراءات الزيارة غير مكتملة. أعد تحميلها قبل التوثيق.");
      }
      // Prepare every editable part before publishing ownership. A malformed B
      // must never combine B identity/notes with procedure drafts left over from A.
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
      const nextNotes = {
        // A scheduled adjustment is reference context, not a new complaint.
        chiefComplaint: pick("chiefComplaint", loaded.chiefComplaint,
          orthodonticDraft || loaded.ortho?.visitAdjustmentId != null ? null : suggested?.chiefComplaint),
        examination: loaded.examination ?? "",
        diagnosis: loaded.diagnosis ?? "", treatmentDone: loaded.treatmentDone ?? "",
        nextPlan: pick("nextPlan", loaded.nextPlan, suggested?.nextPlan),
      };
      if (!loaded.doctorId && suggested?.doctorId) filled.add("doctor");
      const nextDoctorId = loaded.doctorId ?? suggested?.doctorId ?? null;
      const loadedCurrency: Currency = isCurrency(loaded.billingCurrency) ? loaded.billingCurrency : CLINIC_BASE_CURRENCY;
      /* (المراجعة النهائية للمالك — TD-05) العملة ملك البند لا الزيارة:
       * كل سطرٍ يُشتق عملته من **بند خطته هو** في الحمولة المحمّلة نفسها
       * (`procedures[].planCurrency`) — لا من عملةٍ واحدة على مستوى الزيارة
       * ولا من حالة React لم تُثبّت بعد. السطر المرتبط بخطةٍ دولارية يُنسَّق
       * «1,500.00» ولو كانت الزيارة فارغةً قبله؛ والسطر المرتبط بخطةٍ أخرى
       * العملة يُنسَّق بعملتها هو؛ والسطر الحر بالأساس. والمزيج يظهر
       * مجموعين منفصلين وتحذيرًا — والتوقيع المختلط يُرفض من الخادم. */
      const nextDrafts = loaded.procedures.map((line) => {
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
      });
      const nextDoctors = Array.isArray(parties) ? parties : parties?.balances ?? [];
      const newOwner = lastAppliedOwner.current !== owner;
      if (newOwner) {
        setOrthoSession(null); setAddendum(""); setReviewOpen(false); setPickerOpen(false);
        setBillingPreview(null); setOverrideReason(""); setNoChargeAdjustment(false); setNoChargeReason("");
        setServerUnmet([]); setRxOpen(false); setPostOpOpen(false); setPatientContext(null);
        setBusy(false); autoReviewDone.current = false; lastAutoTreatment.current = "";
        explicitTreatmentOwner.current = null;
      }
      lastAppliedOwner.current = owner;
      if (loaded.status === "signed") confirmedSignOwner.current = owner;
      acceptedReadOwner.current = owner;
      setLoadedOwner(owner); setVisit(loaded); setDeniedOwner(null);
      const savedDraftMatches = submitted !== undefined && matchesSubmittedVisit(loaded, submitted.body);
      const keepLocalDraft = !newOwner && loaded.status === "open"
        && draftForLeave.current.owner === owner && draftForLeave.current.dirty
        && (!savedDraftMatches || draftSnapshot.current !== submitted?.snapshot);
      if (!keepLocalDraft) {
        setNotes(nextNotes); setDrafts(nextDrafts);
        setDoctorId(nextDoctorId); setAutoFilled(filled); setVisitCurrency(loadedCurrency); setDirty(false);
      }
      if (serviceResponse.ok || newOwner) setServices(catalog ?? []);
      if (partyResponse.ok || newOwner) setDoctors(nextDoctors);
      if (submitted && keepLocalDraft && savedDraftMatches) {
        setErrorOwner(owner); setError("احتُفظ بتعديلات أحدث من الطلب المحفوظ. احفظها قبل مراجعة التوقيع.");
        return false;
      }
      if (submitted && !savedDraftMatches) {
        setErrorOwner(owner); setError("تعذّر تأكيد حفظ المسودة كاملة. احتُفظ بتعديلاتك؛ راجعها قبل الحفظ مجددًا.");
        return false;
      }
      setError(null);
      return true;
    } catch {
      if (stillCurrent()) {
        acceptedReadOwner.current = null;
        setLoadedOwner(null); setReviewOpen(false); setBillingPreview(null);
        setErrorOwner(owner); setError(failureMessage);
        // Keep the owner's local notes/drafts in memory, but hide the unverified
        // persisted view until a fresh authorized read succeeds.
      }
      return false;
    }
  }, [visitId, expectedPatientId, currentOwner, owner]);

  useEffect(() => { void load(); }, [load]);

  /* (VISIT-1) «ما نُفّذ» يُكتب من الإجراءات المضافة — ويتبعها ما دام الطبيب لم يكتب فيه بنفسه. */
  const visitOpen = visit?.status === "open";
  useEffect(() => {
    if (!visitOpen || !ownsVisit || !currentOwner() || explicitTreatmentOwner.current === owner) return;
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
  }, [drafts, services, visitOpen, visit?.outstanding, ownsVisit, currentOwner, owner]);

  const setNote = (key: NoteKey, value: string) => {
    // A save reloads its submitted snapshot. Do not accept newer edits until
    // both the write and that reload have finished.
    if (busy || !ownsVisit || !currentOwner() || command.current?.owner === owner) return;
    draftForLeave.current = { owner, dirty: true }; setDirty(true);
    if (key === "treatmentDone") explicitTreatmentOwner.current = owner;
    setNotes((current) => ({ ...current, [key]: value }));
    setAutoFilled((current) => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; });
  };
  const send = useCallback(async (body: Record<string, unknown>) => {
    if (busy || !ownsVisit || acceptedReadOwner.current !== owner || !currentOwner() || command.current?.owner === owner
      || (confirmedSignOwner.current === owner && body.action !== "addendum")) return false;
    const attempt = { owner }; command.current = attempt;
    const submitted = body.action ? undefined : { body, snapshot: draftSnapshot.current };
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!currentOwner() || command.current !== attempt) return false;
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return false; }
      setError(null);
      const reloaded = await load(undefined, orthoSession !== null, submitted);
      return reloaded && currentOwner() && command.current === attempt;
    } catch {
      if (currentOwner()) setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      if (currentOwner() && command.current === attempt) { command.current = null; setBusy(false); }
    }
  }, [busy, ownsVisit, currentOwner, owner, visitId, load, orthoSession]);

  /** التوقيع — يستجاب بنتيجة الرحلة كاملة فيمرّرها للشبّاك. */
  const signReadSequence = loadSequence.current;
  const sign = useCallback(async () => {
    if (busy || !ownsVisit || acceptedReadOwner.current !== owner || confirmedSignOwner.current === owner
      || signReadSequence !== loadSequence.current || visit?.status === "signed"
      || !currentOwner() || command.current?.owner === owner) return;
    const blocked = visitSignatureBlock(visit);
    if (blocked) { setError(blocked); return; }
    if (orthoSession?.elastics === "" && visit?.ortho?.visitAdjustmentId === null) {
      setError("اختر صنف المطاطات لهذه الجلسة؛ وصف خط الأساس لا يحدّد الصنف تلقائيًا.");
      return;
    }
    const attempt = { owner }; command.current = attempt;
    setBusy(true);
    setError(null);
    const unknownOutcome = () => {
      if (!currentOwner() || command.current !== attempt) return;
      acceptedReadOwner.current = null;
      loadSequence.current += 1;
      setLoadedOwner(null); setReviewOpen(false); setBillingPreview(null);
      setErrorOwner(owner); setError("تعذّر تأكيد نتيجة التوقيع. قد تكون الزيارة وُقّعت؛ أعد تحميل السجل قبل أي محاولة أخرى.");
    };
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
      const payload = await response.json();
      if (!currentOwner() || command.current !== attempt) return;
      if (!response.ok) {
        if (Array.isArray(payload?.unmetRequirements)) {
          setServerUnmet(payload.unmetRequirements.filter((line: unknown): line is string => typeof line === "string"));
        }
        /* (P1-D) إجراءٌ حرّ يطابق بندًا متعدد الجلسات: سمِّ البند وجلسته المنتظرة. */
        const conflicts = Array.isArray(payload?.sessionConflicts)
          ? payload.sessionConflicts.filter((line: unknown): line is string => typeof line === "string") : [];
        setError([payload?.message ?? "تعذّر التوقيع.", ...conflicts].join(" "));
        return;
      }
      if (!isClinicalSignResult(payload, visitId, expectedPatientId ?? visit?.patientId)) { unknownOutcome(); return; }
      confirmedSignOwner.current = owner;
      setServerUnmet([]);
      setReviewOpen(false);
      setOrthoSession(null); setOverrideReason(""); setNoChargeAdjustment(false); setNoChargeReason("");
      draftForLeave.current = { owner, dirty: false }; setDirty(false);
      // The sign POST has succeeded. A failed follow-up GET must not turn that
      // accepted signature into editable work or suppress its live checkout.
      setVisit((current) => current?.id === visitId ? {
        ...current, status: "signed", invoiceId: typeof payload.invoiceId === "number" ? payload.invoiceId : null,
        signedAt: typeof payload.signedAt === "string" ? payload.signedAt : current.signedAt,
        signedBy: typeof payload.signedBy === "string" ? payload.signedBy : current.signedBy,
      } : current);
      await load("signed");
      if (!currentOwner() || command.current !== attempt) return;
      // A live completed signature may navigate. It is no longer a pending
      // command or an unsaved draft when native beforeunload runs.
      command.current = null; setBusy(false); draftForLeave.current = { owner, dirty: false };
      onSigned?.({
        invoiceId: payload.invoiceId ?? null,
        invoiceCurrency: isCurrency(payload.invoiceCurrency) ? payload.invoiceCurrency : null,
        duesMinor: payload.duesMinor ?? 0,
        sessionsCompleted: payload.sessionsCompleted ?? 0,
        nextPlannedVisit: payload.nextPlannedVisit ?? null,
        labOrdersCreated: payload.labOrdersCreated ?? 0,
        materialsDeducted: payload.materialsDeducted ?? 0,
        patientId: typeof payload.patientId === "number" ? payload.patientId : null,
      });
    } catch {
      unknownOutcome();
    } finally {
      if (currentOwner() && command.current === attempt) { command.current = null; setBusy(false); }
    }
  }, [busy, ownsVisit, currentOwner, owner, visitId, expectedPatientId, load, onSigned, overrideReason, orthoSession, visit, noChargeAdjustment, noChargeReason, signReadSequence]);

  /** (VISIT-2) فتح ملف المريض الجديد من زيارته — يعيد رقم الملف أو null مع رسالة الخطأ. */
  const openPatientFile = useCallback(async (id: number): Promise<number | null> => {
    if (id !== visitId || !ownsVisit || acceptedReadOwner.current !== owner || !currentOwner() || command.current?.owner === owner) return null;
    const attempt = { owner }; command.current = attempt;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open_file" }),
      });
      const payload = await response.json().catch(() => null);
      if (!currentOwner() || command.current !== attempt) return null;
      if (!response.ok || !payload?.patientId) {
        setError(payload?.message ?? "تعذّر فتح ملف المريض.");
        return null;
      }
      return Number(payload.patientId);
    } catch {
      if (currentOwner()) setError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      if (currentOwner() && command.current === attempt) { command.current = null; setBusy(false); }
    }
  }, [visitId, ownsVisit, currentOwner, owner]);

  /* (VISIT-2) الوصول من «مراجعة وإنهاء» لمريضٍ فُتح ملفّه للتوّ: تُفتح المراجعة مرةً واحدة. */
  useEffect(() => {
    if (!autoReview || autoReviewDone.current || !ownsVisit || !currentOwner() || !visit || visit.status !== "open" || !canWrite) return;
    autoReviewDone.current = true;
    setReviewOpen(true);
  }, [autoReview, visit, canWrite, ownsVisit, currentOwner]);

  const hasDraft = dirty || orthoSession !== null || Boolean(addendum.trim() || overrideReason.trim() || noChargeAdjustment || noChargeReason.trim());
  useLayoutEffect(() => {
    draftForLeave.current = { owner, dirty: lastAppliedOwner.current === owner && hasDraft };
  }, [owner, ownsVisit, hasDraft]);
  const canLeave = useCallback(() => {
    if (!currentOwner()) return true;
    if (command.current?.owner === owner) {
      setError("هناك طلب حفظ أو توقيع قيد التنفيذ. انتظر نتيجته قبل الانتقال.");
      return false;
    }
    return draftForLeave.current.owner !== owner || !draftForLeave.current.dirty
      || window.confirm("هناك توثيق للزيارة غير محفوظ. هل تريد تجاهله والانتقال؟");
  }, [ownsVisit, currentOwner, owner]);
  useEffect(() => {
    onNavigationGuardChange?.(canLeave);
    return () => onNavigationGuardChange?.(null);
  }, [onNavigationGuardChange, canLeave]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      const unsaved = draftForLeave.current.owner === owner && draftForLeave.current.dirty;
      if (!currentOwner() || (!unsaved && command.current?.owner !== owner)) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [ownsVisit, currentOwner, owner]);

  const referenceIsExpanded = referenceOwner.key === referenceKey && referenceOpen?.owner === referenceOwner && referenceOpen.open;
  const referenceIsInDetails = Boolean(visit?.ortho && (orthoSession || visit.ortho.visitAdjustmentId != null));
  const visiblePreviousVisitId = ownsVisit && visit?.status === "open" && (!referenceIsInDetails || referenceIsExpanded)
    ? visit.previousVisit?.id ?? null : null;
  useEffect(() => {
    onPreviousVisitReferenceChange?.(visiblePreviousVisitId);
    return () => onPreviousVisitReferenceChange?.(null);
  }, [onPreviousVisitReferenceChange, visiblePreviousVisitId, owner]);

  if (!visit || !ownsVisit) {
    const ownedError = errorOwner === owner ? error : null;
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
      {confirmedSignOwner.current === owner && deniedOwner !== owner ? (
        <p role="status" data-testid="clinical-sign-confirmed" className="mb-2 font-bold text-success-700">وُقّعت الزيارة بنجاح. تعذّر تأكيد عرض السجل؛ لن يُعاد التوقيع.</p>
      ) : null}
      <p role={ownedError ? "alert" : undefined}>{ownedError ?? "جارٍ تحميل الزيارة الحالية…"}</p>
      {lastAppliedOwner.current === owner && draftForLeave.current.dirty && confirmedSignOwner.current !== owner ? (
        <p className="mt-2 text-xs">احتُفظ بمسودة الزيارة لهذه الجلسة؛ التعديل والحفظ متوقفان حتى نجاح إعادة التحميل.</p>
      ) : null}
      {ownedError ? <button type="button" onClick={() => void load()}
        className="mt-2 rounded-xl border border-slate-200 px-3 py-2 font-bold text-navy-800">أعد تحميل الزيارة</button> : null}
    </div>;
  }

  const signed = visit.status === "signed";
  // With no recorded adjustment, the baseline has free text but no structured elastic class.
  const baselineElasticNote = visit.ortho?.lastAdjustment === null ? visit.ortho.elasticNote?.trim() ?? "" : "";
  // An active case is context, not proof that today's visit is orthodontic.
  const orthoFollowUp = !signed && Boolean(visit.ortho && (orthoSession || visit.ortho.visitAdjustmentId != null));
  // Hide the added lab display while another visit is still loaded.
  const labVisitIsCurrent = visit.id === visitId;
  // Category metadata describes eligible work, never order/procedure provenance.
  const eligibleLabWork = Array.from(new Set(drafts.map((draft) => labWorkForCategory(draft.labCategory))
    .filter((work): work is string => typeof work === "string")));
  const updateDrafts = (update: (rows: Draft[]) => Draft[]) => {
    // Procedure changes also regenerate treatmentDone.
    if (busy || !currentOwner() || command.current?.owner === owner) return;
    draftForLeave.current = { owner, dirty: true }; setDirty(true);
    if (!draftSnapshot.current.notes.treatmentDone.trim()) explicitTreatmentOwner.current = null;
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
    if (busy) return;
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
  const signatureBlock = visitSignatureBlock(visit);

  const addPlannedItem = (item: Visit["outstanding"][number]) => {
    if (busy || !currentOwner() || command.current?.owner === owner) return;
    // سعر الجلسة القادمة وفق قاعدة البند — نفس دالة الخادم، فيتطابق الرقمان.
    const lineTotal = item.unitPriceMinor * item.quantity;
    const sessionIndex = item.doneSessions + 1;
    const suggested = hasVerifiedClinicalCoverage(item) ? 0 : priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
    /* (المراجعة النهائية للمالك — TD-05) السعر المقترح يُنسَّق بعملة **بند
       الخطة هذا نفسه** لا بعملةٍ مستنتَجة على مستوى الزيارة: زيارةٌ فارغة لا
       إجراءاتٍ فيها لا تعرف عملتها، فبندٌ دولاري مخزّنٌ ١٥٠٠٠٠ وحدة صغرى
       يُعرض «1,500.00» فورًا — لا «150,000» بالأساس أبدًا. */
    const itemCurrency = isCurrency(item.planCurrency) ? item.planCurrency : base;
    /* (DAY1) زيارةٌ بلا إجراءٍ حرّ تتبع عملة خطة بندها — فلا تتعارض العملتان عند التوقيع. */
    if (!drafts.some((row) => row.planItemId === null)) setVisitCurrency(itemCurrency);
    updateDrafts((rows) => [
      ...rows,
      {
        // Plan staging has no canonical category; a later saved read supplies it.
        labCategory: null,
        serviceId: item.serviceId ?? 0,
        toothCode: item.toothCode ? String(item.toothCode) : "",
        surfaces: item.surfaces ?? "",
        quantity: 1,
        price: formatAmount(suggested, itemCurrency),
        doctorId,
        planItemId: item.planItemId,
        currency: itemCurrency,
      },
    ]);
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

  const canChangeAdjustment = () => !busy && currentOwner() && command.current?.owner !== owner;
  const changeAdjustment = (next: typeof orthoSession) => {
    if (!canChangeAdjustment()) return;
    // Keep the existing leave guard effective even before React commits the new session.
    if (next) draftForLeave.current = { owner, dirty: true };
    setOrthoSession(next);
  };

  const orthodonticEntry = (
    <>
          {!signed && canWrite && visit.ortho ? (
            <section id="visit-ortho-session" aria-label={orthoFollowUp ? "جلسة التقويم اليوم" : "سياق التقويم"} className="mb-3 scroll-mt-4 rounded-2xl border border-navy-200 bg-navy-50 p-3">
              <h3 className="text-sm font-extrabold text-navy-900">{orthoFollowUp ? "جلسة التقويم اليوم" : "للمريض ملف تقويم نشط"}</h3>
              <p className="mt-1 text-xs text-navy-800">
                {orthoFollowUp
                  ? "وثّق ما تغيّر وما نُفّذ في هذه الجلسة. لا حاجة إلى إعادة الشكوى أو الفحص أو التشخيص الأساسي لكل شدّة."
                  : "إذا نُفّذت شدّة اليوم، سجّلها هنا. وإلا أكمل توثيق الزيارة المعتاد أدناه."}
              </p>
              <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
              {visit.ortho.visitAdjustmentId !== null ? (
                <p className="mt-1 text-[11px] font-bold text-emerald-800">✓ سُجّلت شدّة هذه الزيارة</p>
              ) : visit.status === "open" && orthoSession && canEditWork ? (
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="col-span-2 sm:col-span-3 text-[11px] font-bold text-slate-600">
                    ما نُفّذ أو تغيّر اليوم
                    <input value={orthoSession.done} aria-label="ما نُفّذ في الشدّة"
                      onChange={(event) => canChangeAdjustment() && changeAdjustment({ ...orthoSession, done: event.target.value })}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                  </label>
                  <div>
                    <label className="text-[10px] font-bold text-slate-600">
                      السلك العلوي
                      <input value={orthoSession.upperWire} dir="ltr" aria-label="السلك العلوي لهذه الشدّة"
                        onChange={(event) => canChangeAdjustment() && changeAdjustment({ ...orthoSession, upperWire: event.target.value })}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono" />
                    </label>
                    {visit.ortho.suggestedUpper && visit.ortho.suggestedUpper !== visit.ortho.upperWire ? (
                      <button type="button" aria-label="استخدام السلك العلوي المقترح"
                        disabled={busy || orthoSession.upperWire === visit.ortho.suggestedUpper}
                        onClick={() => { if (canChangeAdjustment() && visit.ortho?.suggestedUpper) changeAdjustment({ ...orthoSession, upperWire: visit.ortho.suggestedUpper }); }}
                        className="mt-1 text-[10px] font-bold text-navy-800 underline disabled:text-slate-400">
                        اقتراح اختياري: <span dir="ltr">{visit.ortho.suggestedUpper}</span>
                      </button>
                    ) : null}
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-slate-600">
                      السلك السفلي
                      <input value={orthoSession.lowerWire} dir="ltr" aria-label="السلك السفلي لهذه الشدّة"
                        onChange={(event) => canChangeAdjustment() && changeAdjustment({ ...orthoSession, lowerWire: event.target.value })}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono" />
                    </label>
                    {visit.ortho.suggestedLower && visit.ortho.suggestedLower !== visit.ortho.lowerWire ? (
                      <button type="button" aria-label="استخدام السلك السفلي المقترح"
                        disabled={busy || orthoSession.lowerWire === visit.ortho.suggestedLower}
                        onClick={() => { if (canChangeAdjustment() && visit.ortho?.suggestedLower) changeAdjustment({ ...orthoSession, lowerWire: visit.ortho.suggestedLower }); }}
                        className="mt-1 text-[10px] font-bold text-navy-800 underline disabled:text-slate-400">
                        اقتراح اختياري: <span dir="ltr">{visit.ortho.suggestedLower}</span>
                      </button>
                    ) : null}
                  </div>
                  {baselineElasticNote ? (
                    <p role="status" data-testid="visit-baseline-elastics"
                      className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 sm:col-span-3">
                      وصف المطاطات المحفوظ في خط الأساس: {baselineElasticNote}.
                      اختر الصنف لهذه الجلسة، أو «بلا مطاطات» إذا لم تعد تُستخدم. لا يُستنتج الصنف من الوصف.
                    </p>
                  ) : null}
                  <label className="text-[10px] font-bold text-slate-600">
                    المطاطات
                    <select value={orthoSession.elastics} aria-label="مطاطات هذه الشدّة" required
                      onChange={(event) => {
                        if (!canChangeAdjustment()) return;
                        const elastics = event.target.value as ElasticClass | "";
                        changeAdjustment({ ...orthoSession, elastics,
                          ...(baselineElasticNote && elastics === "none" ? { elasticNote: "" } : {}),
                        });
                      }}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
                      {baselineElasticNote ? <option value="">— اختر الصنف دون تغيير الوصف المحفوظ —</option> : null}
                      {(Object.keys(ELASTIC_LABEL) as ElasticClass[]).map((value) => (
                        <option key={value} value={value}>{ELASTIC_LABEL[value]}</option>
                      ))}
                    </select>
                  </label>
                  {orthoSession.elastics !== "none" && (
                    <label className="col-span-2 text-[10px] font-bold text-slate-600 sm:col-span-3">
                      وصف المطاطات (المقاس، القوة، الجهة، ساعات اللبس)
                      <input value={orthoSession.elasticNote} aria-label="وصف مطاطات هذه الشدّة"
                        onChange={(event) => canChangeAdjustment() && changeAdjustment({ ...orthoSession, elasticNote: event.target.value })}
                        className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                    </label>
                  )}
                  <label className="text-[10px] font-bold text-slate-600">
                    القادمة بعد (أسابيع)
                    <input value={orthoSession.nextWeeks} inputMode="numeric" dir="ltr" aria-label="أسابيع حتى الشدّة القادمة"
                      onChange={(event) => canChangeAdjustment() && changeAdjustment({ ...orthoSession, nextWeeks: event.target.value })}
                      className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" />
                  </label>
                  <p className="col-span-2 text-[10px] text-navy-700 sm:col-span-3">
                    يبدأ السلك والمطاطات بالقيم الحالية؛ عدّل فقط ما تغيّر اليوم. اختيار السلك المقترح اختياري ولا يُطبّق تلقائيًا. تُحفظ الشدّة مع التوقيع فقط، وليس مع «احفظ بلا توقيع».
                    <button type="button" onClick={() => { if (canChangeAdjustment()) changeAdjustment(null); }}
                      className="ms-2 font-bold text-slate-600 underline">إلغاء</button>
                  </p>
                </div>
              ) : visit.status === "open" && canEditWork ? (
                <button type="button"
                  onClick={() => {
                    if (!canChangeAdjustment()) return;
                    // Provenance is tracked by load()/setNote(), not guessed from text.
                    if (autoFilled.has("chiefComplaint")) setNote("chiefComplaint", "");
                    changeAdjustment({
                    upperWire: visit.ortho?.upperWire ?? "",
                    lowerWire: visit.ortho?.lowerWire ?? "",
                    elastics: baselineElasticNote ? "" : (visit.ortho?.elastics as ElasticClass | null) ?? "none",
                    elasticNote: visit.ortho?.elasticNote ?? "", done: "", nextWeeks: String(visit.ortho?.nextWeeks ?? 4),
                    });
                  }}
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
                    <input type="checkbox" checked={noChargeAdjustment} onChange={(event) => { if (canChangeAdjustment()) setNoChargeAdjustment(event.target.checked); }} />
                    بلا رسوم لهذه الشدّة
                  </label>
                  {noChargeAdjustment ? (
                    <input value={noChargeReason} onChange={(event) => { if (canChangeAdjustment()) setNoChargeReason(event.target.value); }}
                      aria-label="سبب بلا رسوم للشدّة" placeholder="السبب — مثل: شدّة تعويضية بعد كسر حاصرة"
                      className="mt-1 w-full rounded-lg border border-rose-200 bg-white px-2 py-1 text-xs" />
                  ) : null}
                </div>
              ) : null}
              </fieldset>
            </section>
          ) : null}
    </>
  );
  const visitReference = (
    <>
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
              <span className="font-extrabold text-navy-900">آخر تشخيص من زيارة موقّعة للمريض</span> ({visit.latestDiagnosis.date}): {visit.latestDiagnosis.text}
            </p>
          ) : null}
          {(visit.activeCases ?? []).filter((one) => one.kind !== "ortho" || !visit.ortho).map((one) => (
            <p key={`${one.kind}-${one.id ?? one.title}`} className="mt-1 text-[11px] text-slate-700">
              <span className="font-extrabold text-navy-900">{one.title}</span>
              {one.status === "waiting" ? <span className="text-amber-700"> · بانتظار</span> : null}
              {one.totalSteps > 0 ? <span className="text-slate-500"> · {one.doneSteps}/{one.totalSteps}</span> : null}
              {one.historicalProgressUnknown ? <span> · تقدّم العلاج السابق غير معلوم؛ العدّ للعمل المعروف خارج البنود التاريخية</span> : null}
              {one.nextStep ? <span> · التالي: {one.nextStep}</span> : null}
              {one.responsibleName ? <span className="text-slate-500"> · {one.responsibleName}</span> : null}
            </p>
          ))}
        </section>
      ) : null}

    </>
  );
  const visitNotes = (
      <div id="visit-notes" className="mb-4 grid scroll-mt-4 gap-2 sm:grid-cols-2">
        {orthoFollowUp ? (
          <>
            <Field label="شكوى جديدة أو تغيّر اليوم (إن وجد)" maxLength={500} value={notes.chiefComplaint} disabled={busy || !canWrite}
              phrases={phrases.chiefComplaint} onPhrase={(phrase) => setNote("chiefComplaint", appendPhrase(notes.chiefComplaint, phrase))}
              onChange={(value) => setNote("chiefComplaint", value)} />
            <Field label="الخطوة القادمة" maxLength={500} value={notes.nextPlan} disabled={busy || !canWrite}
              auto={autoFilled.has("nextPlan")} phrases={phrases.nextPlan}
              onPhrase={(phrase) => setNote("nextPlan", appendPhrase(notes.nextPlan, phrase))}
              onChange={(value) => setNote("nextPlan", value)} />
            <details className="rounded-xl border border-slate-200 p-3 sm:col-span-2"
              open={Boolean(notes.examination || notes.diagnosis || notes.treatmentDone)}>
              <summary className="cursor-pointer text-xs font-bold text-slate-600">فحص أو تشخيص جديد / توثيق إضافي اليوم</summary>
              <p className="mt-1 text-[11px] text-slate-500">عند وجود تغيّر أو عمل إضافي، سجّله هنا. يبقى التوثيق السابق في مرجع الحالة.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="فحص اليوم (إن أُجري)" value={notes.examination} disabled={busy || !canWrite}
                  phrases={phrases.examination} onPhrase={(phrase) => setNote("examination", appendPhrase(notes.examination, phrase))}
                  onChange={(value) => setNote("examination", value)} />
                <Field label="تشخيص جديد أو محدّث (إن وجد)" value={notes.diagnosis} disabled={busy || !canWrite}
                  phrases={phrases.diagnosis} onPhrase={(phrase) => setNote("diagnosis", appendPhrase(notes.diagnosis, phrase))}
                  onChange={(value) => setNote("diagnosis", value)} />
                <Field label="توثيق عمل إضافي اليوم" value={notes.treatmentDone} disabled={busy || !canWrite}
                  hint={notes.treatmentDone && notes.treatmentDone === lastAutoTreatment.current ? "نص مشتق من قائمة الإجراءات؛ يمكنك تعديله. لا يثبت التوقيع أو اكتمال شروط الخطة." : undefined}
                  onChange={(value) => setNote("treatmentDone", value)} />
              </div>
            </details>
          </>
        ) : <>
        {([
          ["chiefComplaint", "① الشكوى الرئيسية", phrases.chiefComplaint],
          ["examination", "② الفحص", phrases.examination],
          ["diagnosis", "② التشخيص", phrases.diagnosis],
        ] as [NoteKey, string, string[]][]).map(([key, label, list]) => (
          <Field key={key} label={label} maxLength={key === "chiefComplaint" ? 500 : 2000} value={notes[key]} disabled={signed || busy || !canWrite}
            auto={autoFilled.has(key)} phrases={signed ? [] : list}
            onPhrase={signed ? undefined : (phrase) => setNote(key, appendPhrase(notes[key], phrase))}
            onChange={(value) => setNote(key, value)} />
        ))}
        <Field label="③ ما نُفّذ" value={notes.treatmentDone} disabled={signed || busy || !canWrite}
          hint={!signed && notes.treatmentDone && notes.treatmentDone === lastAutoTreatment.current ? "نص مشتق من قائمة الإجراءات؛ يمكنك تعديله. لا يثبت التوقيع أو اكتمال شروط الخطة." : undefined}
          onChange={(value) => setNote("treatmentDone", value)} />
        <Field label="الخطة القادمة" maxLength={500} value={notes.nextPlan} disabled={signed || busy || !canWrite}
          auto={autoFilled.has("nextPlan")} phrases={signed ? [] : phrases.nextPlan}
          onPhrase={signed ? undefined : (phrase) => setNote("nextPlan", appendPhrase(notes.nextPlan, phrase))}
          onChange={(value) => setNote("nextPlan", value)} />
        </>}
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">
            الطبيب المعالج
            {autoFilled.has("doctor") ? <span className="mr-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">✨ تلقائي</span> : null}
          </span>
          <select value={doctorId ?? ""} disabled={signed || busy || !canEditWork}
            onChange={(event) => {
              if (busy || !currentOwner()) return;
              draftForLeave.current = { owner, dirty: true }; setDirty(true); setDoctorId(Number(event.target.value) || null);
              setAutoFilled((current) => { const next = new Set(current); next.delete("doctor"); return next; });
            }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm disabled:bg-slate-50">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

  );

  return (
    <div key={owner.generation}>
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-danger-300 bg-danger-50 px-4 py-2 text-sm font-semibold text-danger-700">{error}</p>
      ) : null}

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
          {!signed ? <p className="mt-1 text-[11px] text-slate-600" data-testid="visit-documentation-mode">
            {orthoFollowUp ? "توثيق جلسة تقويم اليوم" : drafts.length > 0 ? "توثيق زيارة بإجراءات مسجلة" : "توثيق زيارة دون إجراءات مسجلة"}
            {" · "}رقم الزيارة #{visit.id} · {dirty ? "تعديلات غير محفوظة" : "المسودة بحسب القراءة الحالية"}
          </p> : null}
          {signed ? (
            <p className="text-[11px] font-semibold text-slate-500">
              وقّعها {visit.signedBy} · {visit.signedAt?.slice(0, 10)}
              {visit.invoiceId ? ` · فاتورة #${visit.invoiceId}` : " · بلا فاتورة (كشف)"}
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
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
            <button
              type="button"
              onClick={() => { if (currentOwner()) setRxOpen(true); }}
              className="flex items-center gap-1 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 transition-colors"
            >
              <span>💊</span>
              <span>روشتة طبية (℞)</span>
            </button>
            <button
              type="button"
              onClick={() => { if (currentOwner()) setPostOpOpen(true); }}
              className="flex items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              <span>📋</span>
              <span>إرشادات المريض</span>
            </button>
          </div>
        ) : null}
      </div>

      <VisitSteps steps={orthoFollowUp ? [
        { id: "visit-ortho-session", label: "جلسة اليوم", done: Boolean(visit.ortho?.visitAdjustmentId || orthoSession?.done.trim()) },
        { id: "visit-notes", label: "تغيّرات اليوم", done: Boolean(notes.chiefComplaint.trim() || notes.nextPlan.trim()) },
        { id: "visit-procedures", label: "إجراءات إضافية", done: drafts.length > 0 },
        { id: "visit-sign", label: "المراجعة والتوقيع", done: false },
      ] : [
        { id: "visit-notes", label: "الشكوى", done: Boolean(notes.chiefComplaint.trim()) || signed },
        { id: "visit-notes", label: "الفحص والتشخيص", done: Boolean(notes.examination.trim() || notes.diagnosis.trim()) || signed },
        { id: "visit-procedures", label: "الإجراءات", done: drafts.length > 0 || signed },
        { id: "visit-sign", label: "المراجعة والتوقيع", done: signed },
      ]} />

      {orthodonticEntry}
      {orthoFollowUp ? (
        <>
          {visitNotes}
          <details key={`${referenceOwner.key}:${referenceOwner.generation}`} className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="ortho-visit-reference"
            open={referenceOwner.key === referenceKey && referenceOpen?.owner === referenceOwner && referenceOpen.open}
            onToggle={(event) => {
              if (event.target !== event.currentTarget || !ownsVisit || !currentOwner()
                || !referenceOwner.active || referenceOwner.key !== referenceKey) return;
              const open = event.currentTarget.open;
              setReferenceOpen((previous) => previous?.owner === referenceOwner && previous.open === open
                ? previous : { owner: referenceOwner, open });
            }}>
            <summary className="min-h-11 cursor-pointer py-3 text-xs font-extrabold text-navy-900">مرجع الحالة: التشخيص والخطة وخط الأساس والجلسة السابقة</summary>
            <p className="my-2 text-[11px] text-slate-500">للقراءة فقط؛ لا تُنسخ هذه المعلومات إلى فحص اليوم أو تشخيصه.</p>
            {visit.ortho ? (
              <div className="mb-3 rounded-xl border border-navy-200 bg-navy-50 px-3 py-2">
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
                <p className="mt-1 text-[11px] text-navy-800">
                  {visit.ortho.legacyBaseline ? "متابعة على خط أساس من العلاج السابق." : "تفاصيل خط الأساس محفوظة في ملف التقويم إن كانت مسجّلة."}
                  {visit.patientId ? <a href={`/patients/${visit.patientId}?tab=ortho`}
                onClick={(event) => { if (!currentOwner()) event.preventDefault(); }} className="ms-2 font-bold underline">عرض ملف التقويم وخط الأساس</a> : null}
                </p>
              </div>
            ) : null}
            {referenceOwner.key === referenceKey && referenceOpen?.owner === referenceOwner && referenceOpen.open && visit.patientId && visit.ortho ? (
              <section className="mb-3 rounded-xl border border-slate-200 bg-white p-3" aria-label="تشخيص حالة التقويم للمرجع">
                <PatientDiagnosis key={`${referenceOwner.key}:${referenceOwner.generation}`} patientId={visit.patientId}
                  orthoCaseId={visit.ortho.caseId} readOnly referenceVisitId={visitId} />
              </section>
            ) : null}
            {visit.suggestions?.chiefComplaint ? <p className="mb-2 text-[11px] text-slate-600">سبب الموعد / الجلسة المخطّطة: {visit.suggestions.chiefComplaint}</p> : null}
            {visitReference}
          </details>
        </>
      ) : <>{visitReference}{visitNotes}</>}

      <section id="visit-procedures" className="mb-4 min-w-0 scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-3" aria-label="قائمة عمل الزيارة">
        <fieldset disabled={busy || !canEditWork} className="m-0 min-w-0 border-0 p-0">
        {!signed && canWrite ? (
          <div className="mb-2 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="عملة الزيارة">
            <span className="text-xs font-extrabold text-navy-900">عملة الزيارة:</span>
            {CURRENCY_CHOICES.map((choice) => (
              <button key={choice.value} type="button" role="radio" aria-checked={visitCurrency === choice.value}
                onClick={() => {
                  if (busy || choice.value === visitCurrency) return;
                  if (!currentOwner()) return;
                  draftForLeave.current = { owner, dirty: true }; setDirty(true); setVisitCurrency(choice.value);
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-navy-900">قائمة عمل الزيارة</h3>
            <p className="mt-1 text-[11px] text-slate-500">{drafts.length} إجراء مسجل{!signed ? ` · ${plannedToday.length} بند متبقٍ من الخطط` : ""} · المبالغ بعملة كل بند</p>
          </div>
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

        {!signed && canWrite ? (
          <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="block text-xs font-extrabold text-navy-900">إجراء إضافي من دليل المركز</span>
              <button ref={servicePickerTrigger} type="button" onClick={() => { if (!busy && canEditWork && currentOwner()) setPickerOpen(true); }}
                aria-label="أضف إجراءً" className="min-h-11 rounded-xl border border-navy-800 bg-white px-3 py-2 text-[11px] font-black text-navy-800">
                ابحث وأضف إجراءً
              </button>
            </div>
            <QuickServicePicker
              open={pickerOpen && !busy && canEditWork}
              onClose={() => { if (currentOwner()) { setPickerOpen(false); servicePickerTrigger.current?.focus(); } }}
              currency={visitCurrency}
              services={services}
              allowUnpriced
              title="أضف إجراءً للزيارة"
              onPick={(service) => addFreeProcedure(service as Service)}
            />

          </div>
        ) : null}
        {drafts.length === 0 ? (
          <p className="mb-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-600">
            لا إجراءات مسجلة اليوم. يمكن توثيق الفحص والملاحظات؛ الاستحقاق والتوقيع يخضعان للتحقق في المراجعة.
          </p>
        ) : null}
        <ul className="space-y-2" aria-label="بنود عمل الزيارة">
            {drafts.map((draft, index) => {
              const service = services.find((row) => row.id === draft.serviceId);
              const note = sessionNoteForDraft(draft, index);
              const planItem = visit.outstanding.find((item) => item.planItemId === draft.planItemId);
              return (
                <li key={index} data-testid="visit-work-recorded" className={`min-w-0 rounded-xl border p-3 ${
                  draft.planItemId ? "border-navy-200 bg-navy-50/30" : "border-slate-200 bg-white"
                }`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-navy-900">{service?.name ?? planItem?.serviceName ?? "خدمة"}</span>
                    {draft.toothCode ? (
                      <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[11px] font-bold text-navy-800">
                        {toothName(Number(draft.toothCode))}
                      </span>
                    ) : null}
                    {draft.planItemId ? (
                      <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[10px] font-extrabold text-navy-800">
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
                  <p className="mb-2 text-[11px] text-slate-600">
                    {signed ? "إجراء في الزيارة الموقّعة" : "مسجل في مسودة اليوم؛ لم تُوقّع الزيارة"}
                    {planItem ? ` · الخطة: ${planItem.planTitle}${planItem.caseId ? ` · الحالة #${planItem.caseId}` : ""}${planItem.caseSite ? ` · ${planItem.caseSite}` : ""}` : draft.planItemId ? ` · بند الخطة #${draft.planItemId}` : " · إجراء من الدليل"}
                  </p>
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
                  {draft.planItemId !== null && !signed ? <VisitPlanRequirements item={planItem} /> : null}
                </li>
              );
            })}
          {!signed ? <>
            {plannedToday.map((item) => {
              const sessionIndex = item.doneSessions + 1;
              const lineTotal = item.unitPriceMinor * item.quantity;
              const price = hasVerifiedClinicalCoverage(item) ? 0 : priceForSession(item.billingRule, lineTotal, item.sessionCount, sessionIndex);
              return (
                <li key={item.planItemId} data-testid={`planned-item-${item.planItemId}`}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 px-3 py-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-xs font-bold text-navy-900">
                      {item.serviceName}
                      {item.toothCode ? <span className="rounded-lg bg-navy-50 px-1.5 py-0.5 mr-1.5 text-[10px] font-bold text-navy-800">سن {item.toothCode}</span> : null}
                      {item.surfaces ? <span data-testid={`planned-item-surfaces-${item.planItemId}`} className="ms-1 text-[10px]">أسطح {item.surfaces}</span> : null}
                      {item.sessionCount > 1 ? (
                        <span className="text-[10px] font-normal text-slate-500">
                          {" "}· جلسة {sessionIndex} من {item.sessionCount}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs font-bold text-navy-800">
                      سعر الجلسة من الخطة: {hasUnresolvedClinicalFinance(item) ? "غير محسوم" : formatMoney(price, item.planCurrency)}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      {hasUnresolvedClinicalFinance(item)
                        ? "التغطية المالية غير محسومة؛ يمكن توثيق العمل كمسودة"
                        : item.prebilled
                        ? "مفوتر مسبقًا — لا تُنشأ فاتورة ثانية لهذا البند"
                        : item.includedByAgreement
                          ? "مشمولة في اتفاق الأقساط — لا تُفوتر الجلسة"
                        : <>{BILLING_RULE_LABEL[item.billingRule]}{price === 0 ? " — تُسعَّر هذه الجلسة وفق قاعدة البند" : ""}</>}
                      {" · من «"}{item.planTitle}{"»"}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-600">
                      لم يُضف إلى عمل اليوم{item.caseId ? ` · الحالة #${item.caseId}` : ""}{item.caseSite ? ` · ${item.caseSite}` : ""}
                    </p>
                    <VisitPlanRequirements item={item} />
                  </div>
                  <button type="button" onClick={() => addPlannedItem(item)}
                    className="min-h-11 rounded-xl border border-navy-200 bg-white px-3 py-2 text-[11px] font-extrabold text-navy-800 hover:bg-navy-50">
                    + نفّذ اليوم
                  </button>
                </li>
              );
            })}
          </> : null}
        </ul>

        {labVisitIsCurrent && !signed && eligibleLabWork.length > 0 ? (
          <p role="note" data-testid="clinical-lab-sign-guidance" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-5 text-sky-900">
            عند توقيع الزيارة بعد مراجعتها سريريًا، ينشئ النظام طلب مختبر «لم يُرسل بعد» للعمل المؤهل ({eligibleLabWork.join("، ")}) إذا لم يوجد طلب قائم وفق قواعد النظام. لا توقّع الزيارة لمجرد إنشاء طلب مختبر.
          </p>
        ) : null}

        </fieldset>
      </section>

      {labVisitIsCurrent ? <section aria-label="طلبات المختبر المرتبطة بالزيارة" data-testid="clinical-visit-lab-orders" className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs">
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
      </section> : null}

      {/* (P4) المواد المصروفة: التلقائية من ربط الخدمات واليدوية لهذه الزيارة — من سجل حركات المخزون نفسه. */}
      {/* (P0-F) المساعد السريري لا يصرف مخزونًا ولا يرى سجل المواد — للطبيب والإدارة. */}
      {canEditWork ? <VisitMaterials visitId={visit.id} canAdd={canWrite} /> : null}

      {signed ? (
        <section aria-label="الملاحق">
          {visit.addendum ? (
            <pre className="mb-3 whitespace-pre-wrap rounded-xl border border-warning-300 bg-warning-50 p-3 text-[11px] font-semibold leading-5 text-warning-900">
              {visit.addendum}
            </pre>
          ) : null}
          {canWrite ? (
            <>
              <textarea value={addendum} onChange={(event) => { if (!busy && currentOwner()) setAddendum(event.target.value); }}
                rows={2} placeholder="ملحق تصحيحي — يُضاف ولا يمحو ما قبله"
                aria-label="ملحق"
                className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
              <button
                onClick={async () => {
                  if (await send({ action: "addendum", text: addendum }) && currentOwner()) setAddendum("");
                }}
                disabled={busy || !addendum.trim()}
                className="rounded-xl border border-warning-300 bg-warning-50 px-4 py-2 text-sm font-bold text-warning-900 disabled:opacity-40">
                أضف ملحقًا
              </button>
            </>
          ) : null}
        </section>
      ) : canWrite ? (
        <>
          {visit.patientId === null ? (
            <LinkPatient visitId={visit.id} suggestion={visit.patientName} canAct={currentOwner} onLinked={() => void load()}
              onOpenFile={async () => {
                if (!(await send(payload())) || !currentOwner()) return;
                const patientId = await openPatientFile(visit.id);
                if (patientId && currentOwner()) window.location.href = `/patients/${patientId}?tab=today`;
              }} />
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

        {signatureBlock ? <p role="status" data-testid="visit-signature-blocked"
          className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-bold text-amber-900">{signatureBlock}</p> : null}
        <div id="visit-sign" className="flex scroll-mt-4 flex-wrap gap-2">
          <button onClick={() => void send(payload())} disabled={busy}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-navy-800 disabled:opacity-40">
            احفظ بلا توقيع
          </button>
          <button
            onClick={async () => {
              if (!currentOwner()) return;
              if (orthoSession?.elastics === "" && visit.ortho?.visitAdjustmentId === null) {
                setError("اختر صنف المطاطات لهذه الجلسة؛ وصف خط الأساس لا يحدّد الصنف تلقائيًا.");
                return;
              }
              // الحفظ ثم المراجعة: توقيعٌ يترك ما كُتب في الشاشة غير محفوظ يفقد العمل.
              if (!(await send(payload())) || !currentOwner()) return;
              /* (VISIT-2) المريض الجديد بلا ملف: يُفتح ملفّه أولًا ثم يكمل الإنهاء من «زيارة اليوم»
                 في ملفّه — فيأتي بعد التوقيع الشبّاك (التحصيل وحجز الجلسة القادمة) ويبقى الملف مفتوحًا. */
              if (visit.patientId === null) {
                const patientId = await openPatientFile(visit.id);
                if (patientId && currentOwner()) window.location.href = `/patients/${patientId}?tab=today&review=1`;
                return;
              }
              setReviewOpen(true);
            }}
            disabled={busy}
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
          الإنهاء يوقّع الزيارة فيولّد الفاتورة بأسعار الخطة، وينجز الجلسات، ويحدّث
          المخطط السني، ويقترح الجلسة القادمة — كلها في عملية واحدة. وبعده لا تُعدَّل
          الزيارة — التصحيح بملحق يحمل كاتبه ووقته.
        </p>
      ) : null}

      {/* شاشة المراجعة والإنهاء (المواصفة §٢١): ما نُفّذ، وما لم يُنفّذ، والاستحقاق،
          والجلسة القادمة — ثم تأكيدٌ واحد لا يفاجئ أحدًا برقم. */}
      {reviewOpen ? (
        <div role="dialog" aria-modal="true" aria-label="مراجعة وإنهاء الزيارة"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-2 sm:p-4"
          onClick={() => { if (!busy && currentOwner()) setReviewOpen(false); }}
          onKeyDown={handleReviewKeyDown}>
          <section ref={reviewPanel} tabIndex={-1} className="flex max-h-[90dvh] w-full min-w-0 max-w-xl flex-col overflow-hidden rounded-2xl border border-navy-800 bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}>
            <header className="shrink-0 border-b border-slate-100 p-4">
              <h3 className="text-sm font-extrabold text-navy-900">مراجعة وإنهاء الزيارة</h3>
              <p className="text-[11px] text-slate-500">{visit.patientName} · زيارة #{visit.id} · راجع التوثيق والاستحقاق قبل التأكيد</p>
            </header>

            <dl className="min-h-0 space-y-2 overflow-y-auto overscroll-contain p-4 text-xs" data-testid="visit-review-scroll">
              {signatureBlock ? <div><dt className="sr-only">تنبيه التوقيع</dt><dd role="status" className="rounded-xl bg-amber-50 p-3 font-bold text-amber-900">{signatureBlock}</dd></div> : null}
              <div className="rounded-xl border border-slate-200 p-3">
                <dt className="font-bold text-navy-900">التوثيق السريري</dt>
                <dd>
                  <details>
                    <summary className="min-h-11 cursor-pointer py-3 text-slate-700">مراجعة نص الزيارة</summary>
                    <dl className="space-y-2 break-words whitespace-pre-wrap">
                      {([
                        ["الشكوى", notes.chiefComplaint], ["الفحص", notes.examination],
                        ["التشخيص", notes.diagnosis], ["ما نُفّذ", notes.treatmentDone],
                      ] as const).map(([label, value]) => <div key={label}>
                        <dt className="font-bold text-slate-600">{label}</dt>
                        <dd>{value.trim() || "لم يُكتب"}</dd>
                      </div>)}
                    </dl>
                  </details>
                </dd>
              </div>
              {orthoSession && visit.ortho?.visitAdjustmentId === null ? (
                <div className="rounded-xl border border-navy-200 bg-navy-50 p-3" data-testid="ortho-session-review">
                  <dt className="font-extrabold text-navy-900">شدّة التقويم اليوم</dt>
                  <dd className="mt-1 space-y-1 text-navy-800">
                    <p>{orthoSession.done.trim() || "لم يُكتب وصف لما نُفّذ في الشدّة"}</p>
                    <p>علوي <span dir="ltr">{orthoSession.upperWire || "—"}</span> · سفلي <span dir="ltr">{orthoSession.lowerWire || "—"}</span></p>
                    <p>المطاطات: {orthoSession.elastics ? ELASTIC_LABEL[orthoSession.elastics] : "لم يُحدّد الصنف بعد"}{orthoSession.elasticNote ? ` · ${orthoSession.elasticNote}` : ""}</p>
                    <p>الشدّة القادمة بعد {Number(orthoSession.nextWeeks) || 4} أسابيع</p>
                  </dd>
                </div>
              ) : visit.ortho?.visitAdjustmentId != null ? (
                <div className="rounded-xl border border-navy-200 bg-navy-50 p-3">
                  <dt className="font-extrabold text-navy-900">شدّة التقويم اليوم</dt>
                  <dd>سُجّلت لهذه الزيارة؛ لن تُضاف مرة أخرى عند التوقيع.</dd>
                </div>
              ) : null}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <dt className="mb-1 font-extrabold text-navy-900">الإجراءات المسجلة للمراجعة</dt>
                {doneToday.length > 0 ? (
                  <dd className="space-y-0.5">
                    {doneToday.map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex flex-wrap justify-between gap-2 text-navy-900">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""}</span>
                          <span className="font-bold">{formatMoney(amount, draft.currency)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : (
                  <dd className="text-slate-500">{drafts.length === 0 ? "لا إجراءات مسجلة؛ راجع الملاحظات وأي جلسة موثقة، ثم الاستحقاق من الخادم." : "الإجراءات المسجلة التالية من الدليل."}</dd>
                )}
                {drafts.length > doneToday.length ? (
                  <dd className="mt-1 space-y-0.5">
                    {drafts.filter((draft) => draft.planItemId === null).map((draft, index) => {
                      const service = services.find((row) => row.id === draft.serviceId);
                      const amount = (parseAmount(draft.price, draft.currency) ?? 0) * draft.quantity;
                      return (
                        <p key={index} className="flex flex-wrap justify-between gap-2 text-slate-700">
                          <span>{service?.name ?? "إجراء"}{draft.toothCode ? ` — سن ${draft.toothCode}` : ""} (غير مخطَّط)</span>
                          <span className="font-bold">{formatMoney(amount, draft.currency)}</span>
                        </p>
                      );
                    })}
                  </dd>
                ) : null}
              </div>

              {notDoneToday.length > 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <dt className="mb-1 font-extrabold text-slate-700">بنود لم تُضف إلى هذه الزيارة</dt>
                  <dd className="space-y-0.5 text-slate-600">
                    {notDoneToday.map((item) => (
                      <p key={item.planItemId}>
                        {item.serviceName}{item.toothCode ? ` — سن ${item.toothCode}` : ""}
                        {item.sessionCount > 1 ? ` (جلسة ${item.doneSessions + 1} من ${item.sessionCount})` : ""}
                      </p>
                    ))}
                  </dd>
                </div>
              ) : null}

              {unmetInVisit.length > 0 ? (
                <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  <dt className="font-extrabold">بنودٌ تتطلب ما لم يكتمل بعد</dt>
                  <dd className="space-y-1">
                    {unmetInVisit.map((line) => <p key={line}>⚠️ {line}</p>)}
                    <textarea value={overrideReason} onChange={(event) => { if (!busy && currentOwner()) setOverrideReason(event.target.value); }} maxLength={300}
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

              {signatureBlock || !billingPreview ? (
                <div role="status" data-testid="visit-financial-review-required" className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                  <dt className="font-extrabold text-amber-900">الاستحقاق المالي غير متحقق</dt>
                  <dd className="mt-1 font-bold text-amber-800">{signatureBlock ?? "لم تكتمل معاينة الاستحقاق من الخادم؛ مبالغ المسودة ليست مبلغًا للتحصيل."}</dd>
                </div>
              ) : serverZeroDue ? (
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

            <div className="flex shrink-0 flex-wrap gap-2 border-t border-slate-100 bg-white p-3">
              <button type="button" disabled={busy} onClick={() => { if (!busy && currentOwner()) setReviewOpen(false); }}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600">
                رجوع — أكمل العمل
              </button>
              <button type="button" onClick={() => void sign()} disabled={busy || Boolean(signatureBlock)}
                className="flex-[2] rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
                {busy
                  ? "جارٍ الإنهاء…"
                  : signatureBlock ? "التوقيع متوقف لحين استكمال المراجعة"
                  : !billingPreview ? "تأكيد التوقيع — يعاد التحقق من الاستحقاق في الخادم"
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
        isOpen={rxOpen}
        onClose={() => { if (currentOwner()) setRxOpen(false); }}
        patientId={visit?.patientId ?? undefined}
        patientName={visit?.patientName ?? ""}
        /* التنبيه الطبي والهاتف يمرّان ليُفحص أمان الدواء داخل الزيارة نفسها —
           فحص السلامة بلا بيانات المريض نصٌّ فارغ (P0.10). */
        medicalAlert={readyPatientContext?.medicalAlert ?? null}
        patientPhone={readyPatientContext?.phone ?? null}
        patientContextStatus={patientContextStatus}
        defaultDiagnosis={notes.diagnosis}
        defaultDoctorName={doctors.find((d) => d.id === doctorId)?.name ?? ""}
      />

      <PostOpModal
        isOpen={postOpOpen}
        onClose={() => { if (currentOwner()) setPostOpOpen(false); }}
        patientId={visit?.patientId ?? 0}
        patientName={visit?.patientName ?? ""}
        initialTreatmentText={notes.treatmentDone || notes.diagnosis || ""}
      />
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
function LinkPatient({ visitId, suggestion, canAct, onLinked, onOpenFile }: {
  visitId: number; suggestion: string; canAct: () => boolean; onLinked: () => void; onOpenFile: () => Promise<void>;
}) {
  const [term, setTerm] = useState(suggestion);
  const [matches, setMatches] = useState<{ id: number; patientNumber: string; fullName: string; phone: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !canAct()) return;
    const text = term.trim();
    if (text.length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/patients?q=${encodeURIComponent(text)}`, { cache: "no-store" });
          if (!response.ok || !canAct()) return;
          const payload = await response.json();
          if (canAct()) setMatches(Array.isArray(payload) ? payload.slice(0, 5) : []);
        } catch {
          // البحث مساعدةٌ لا شرط — تعذّره لا يمنع التوقيع.
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [term, open, canAct]);

  const link = async (patientId: number) => {
    if (busy || !canAct()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${visitId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link", patientId }),
      });
      if (response.ok && canAct()) { setOpen(false); onLinked(); }
    } finally {
      if (canAct()) setBusy(false);
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
          onClick={async () => { if (!canAct()) return; setBusy(true); try { await onOpenFile(); } finally { if (canAct()) setBusy(false); } }}
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
