"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  CURRENCY_SHORT,
  formatAmount,
  formatMoney,
  isCurrency,
  parseAmount,
  toInputAmount,
  type Currency,
} from "@/lib/money";
import { PLAN_STATUS_LABEL, splitInstallments } from "@/lib/plans";
import { checkPlanAgreementPricing } from "@/lib/plan-agreement-pricing";
import {
  BILLING_RULE_LABEL, BILLING_RULES, PLANNED_VISIT_STATUS_LABEL,
  type BillingRule, type PlannedVisitStatus,
} from "@/lib/workflow";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { ServiceSelect } from "./ServiceSelect";
import { TemplatePlanForm } from "./TemplatePlanForm";
import { ToothField } from "./ToothPicker";
import { useSession } from "./SessionProvider";
import { NO_PATIENT_PLAN_CAPABILITIES, groupProjectedPlanItems, type PatientPlanCapabilities, type PatientPlanProjection, type FinancialPatientPlan } from "@/lib/patient-plan-projection";
import { ReceiptCorrectionLauncher } from "./ReceiptCorrectionLauncher";
import { QuickPlanForm } from "./QuickPlanForm";
import { QuickAgreementPlanForm } from "./QuickAgreementPlanForm";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { patientRecordFocusKey, resolvePlanItemFocus, type PatientPlanItemFocus, type PatientRecordFocus } from "@/lib/patient-workspace-focus";
import type { CasePlanItem, SpecialtyCase } from "@/lib/db";
import { readPatientAppointmentVisibility, type PatientAppointmentReadVisibility } from "@/lib/appointment-read-scope";
import type { PlannedVisitCalendar } from "@/lib/patient-workflow-calendar";
import { patientPlanCalendar, patientPlanAppointmentEmptyText } from "@/lib/patient-plan-calendar";

/**
 * خطط علاج المريض — زرٌّ واحد، والتعقيد خيارٌ داخل النموذج (المواصفة §٧).
 *
 * كان إنشاء الخطة طريقين ظاهرين للمستخدم (سريرية ببنود / مالية بأقساط)؛ والآن
 * زرٌّ واحد «+ إنشاء خطة علاج» يفتح نموذجًا واحدًا: الاسم والتخصص والطبيب والبنود،
 * ثم طريقة التسعير (بنودٌ مسعَّرة أو مبلغٌ متفق عليه)، ثم طريقة الدفع (حسب
 * المنفَّذ أو أقساط أو جدول مخصص). والكائن في القاعدة واحد في الحالتين.
 *
 * والطبيب يرى خططه سريريًا (البنود والجلسات والزيارات المخطَّطة) — وكل ما هو
 * مالي يُخفى عنه في الخادم إلا بإذنٍ صريح.
 */

interface Service { id: number; name: string; category: string | null; priceMinor: number }
interface Doctor { id: number; name: string }

type Plan = PatientPlanProjection;
interface PlannedVisit extends PlannedVisitCalendar {
  id: number; planTitle: string | null; sequence: number; title: string;
  doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
  note: string | null;
}

const SPECIALTIES = ["علاج عام", "تقويم", "زراعة", "تركيبات", "جراحة", "تجميل"];

export function PatientPlans({ patientId, focus, onNavigationGuardChange, openVisitId = null, onFocus }: {
  patientId: number; focus?: PatientPlanItemFocus | null;
  openVisitId?: number | null; onFocus?: (focus: PatientRecordFocus) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
}) {
  // (TD-05) الأساس دستوري من الكود — وعملة كل خطةٍ تُعرض بعملتها هي.
  const fallback: Currency = CLINIC_BASE_CURRENCY;
  const session = useSession();
  const authorityKey = JSON.stringify([session?.username, session?.role, session?.permissions]);
  const loadSequence = useRef(0);
  const identityKey = `${patientId}:${authorityKey}`;
  const contextOwner = useRef({ identityKey, generation: 0 });
  if (contextOwner.current.identityKey !== identityKey) contextOwner.current = { identityKey, generation: contextOwner.current.generation + 1 };
  const contextKey = `${identityKey}:${contextOwner.current.generation}`;
  const currentPatient = useRef(patientId);
  currentPatient.current = patientId;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const mounted = useRef(false);
  // Retained handlers lose authority at the unmount commit, before passive cleanup.
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrentContext = useCallback(() => mounted.current && currentContext.current === contextKey, [contextKey]);
  const [loadedContextKey, setLoadedContextKey] = useState<string | null>(null);
  const readyContext = useRef<string | null>(null);
  const reading = useRef(true);
  const [readError, setReadError] = useState(false);
  const [cachedPlans, setPlans] = useState<Plan[]>([]);
  const [cachedPlannedVisits, setPlannedVisits] = useState<PlannedVisit[]>([]);
  const [cachedAppointmentVisibility, setAppointmentVisibility] = useState<PatientAppointmentReadVisibility>("unknown");
  const [cachedFinancial, setCanSeeFinancial] = useState(false);
  const [cachedCapabilities, setCapabilities] = useState<PatientPlanCapabilities>(NO_PATIENT_PLAN_CAPABILITIES);
  const [base, setBase] = useState<Currency>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [quickCreating, setQuickCreating] = useState(false);
  const [agreementCreating, setAgreementCreating] = useState(false);
  /* (SPEC-T1) خطة من قالب التخصص — بجانب الإنشاء اليدوي لا بدلًا منه. */
  const [fromTemplate, setFromTemplate] = useState(false);
  const [payFor, setPayFor] = useState<number | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payCurrency, setPayCurrency] = useState<Currency>(fallback);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [consentFor, setConsentFor] = useState<number | null>(null);
  const [focusLoaded, setFocusLoaded] = useState(false);
  const [loadedFocusKey, setLoadedFocusKey] = useState<string | null>(null);
  const [focusCases, setFocusCases] = useState<{ planVisible: boolean; cases: SpecialtyCase[]; items: CasePlanItem[] } | null>(null);
  const focusCasesRef = useRef<typeof focusCases>(null);
  const currentOpenVisit = useRef(openVisitId);
  currentOpenVisit.current = openVisitId;

  const itemActivities = useRef(new Map<number, { dirty: boolean; busy: boolean }>());
  const [itemsEpoch, setItemsEpoch] = useState(0);
  // A settled transport is not proof of rollback. This parent-scope latch
  // survives editor close/reopen; it is intentionally not server idempotency.
  const uncertainAttempts = useRef(new Map<symbol, { patientId: number; kind: "create" | "item" | "consent"; planId?: number; reviewAfter: number }>());
  const [, refreshUncertainty] = useState(0);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const [itemRecovery, setItemRecovery] = useState<Record<number, number>>({});
  const reviewedRead = useRef({ contextKey: "", sequence: 0 });
  const hasUncertainAttempt = useCallback(() => [...uncertainAttempts.current.values()].some((attempt) => attempt.patientId === patientId), [patientId]);
  const markUncertain = useCallback((kind: "create" | "item" | "consent", planId?: number) => {
    uncertainAttempts.current.set(Symbol("uncertain-plan-write"), { patientId, kind, planId, reviewAfter: loadSequence.current + 1 });
    if (mounted.current) refreshUncertainty((value) => value + 1);
  }, [patientId]);
  const projection = useRef<{ contextKey: string; plans: Plan[]; capabilities: PatientPlanCapabilities } | null>(null);
  const openForms = useRef({ contextKey, creating, quickCreating, agreementCreating, fromTemplate, payFor, consentFor });
  openForms.current = { contextKey, creating, quickCreating, agreementCreating, fromTemplate, payFor, consentFor };
  // Request ownership outlives a forced child unmount. Only that request's
  // finally releases its token; another instance of the same plan cannot retry it.
  const itemWrites = useRef(new Map<symbol, number>());
  const [itemWriteCount, setItemWriteCount] = useState(0);
  const trackItemActivity = useCallback((planId: number, activity: { dirty: boolean; busy: boolean } | null) => {
    if (activity) itemActivities.current.set(planId, activity); else itemActivities.current.delete(planId);
  }, []);

  // Same-context refresh preserves mounted draft owners; a new identity never
  // projects the previous patient's/authority's cached data even for one render.
  const sameContext = loadedContextKey === contextKey;
  const plans = sameContext ? cachedPlans : [];
  // Calendar certainty retires during a refresh/error; clinical draft ownership stays intact.
  const { plannedVisits } = patientPlanCalendar({
    plannedVisits: sameContext ? cachedPlannedVisits : [],
    appointmentVisibility: sameContext && !loading && !readError ? cachedAppointmentVisibility : "unknown",
  });
  const canSeeFinancial = sameContext && cachedFinancial;
  const capabilities = sameContext ? cachedCapabilities : NO_PATIENT_PLAN_CAPABILITIES;
  const isAuthorityReady = useCallback(() => isCurrentContext() && !reading.current && readyContext.current === contextKey, [contextKey, isCurrentContext]);
  const latestPlan = (planId: number) => {
    const matches = projection.current?.contextKey === contextKey ? projection.current.plans.filter((plan) => plan.id === planId && plan.patientId === patientId) : [];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const creationAllowed = useCallback((kind: string) => {
    const access = projection.current?.contextKey === contextKey ? projection.current.capabilities : NO_PATIENT_PLAN_CAPABILITIES;
    return kind === "consent" ? access.canRecordConsent : access.canEditPlans && (!["quick", "advanced"].includes(kind) || access.canViewCatalogPrices);
  }, [contextKey]);
  const creationWrites = useRef(new Map<string, string>());
  const [creationBusy, setCreationBusy] = useState(false);
  const trackCreation = useCallback((kind: string, pending: boolean): boolean => {
    const forms = openForms.current;
    const isOpen = kind === "quick" ? forms.quickCreating : kind === "agreement" ? forms.agreementCreating : kind === "template" ? forms.fromTemplate : kind === "advanced" ? forms.creating : forms.consentFor !== null;
    if (pending && (!isOpen || forms.contextKey !== contextKey)) return false;
    if (pending && (creationWrites.current.size > 0 || itemWrites.current.size > 0 || inFlightRef.current || hasUncertainAttempt() || !creationAllowed(kind))) return false;
    if (pending && !isAuthorityReady()) { setError("تعذّر تأكيد الصلاحيات الحالية؛ أعد تحميل الخطط قبل الحفظ."); return false; }
    if (pending) creationWrites.current.set(kind, contextKey); else if (creationWrites.current.get(kind) === contextKey) creationWrites.current.delete(kind);
    setCreationBusy(creationWrites.current.size > 0); return true;
  }, [contextKey, isAuthorityReady, creationAllowed, hasUncertainAttempt]);
  const trackQuick = useCallback((pending: boolean) => trackCreation("quick", pending), [trackCreation]);
  const trackAgreement = useCallback((pending: boolean) => trackCreation("agreement", pending), [trackCreation]);
  const trackTemplate = useCallback((pending: boolean) => trackCreation("template", pending), [trackCreation]);
  const trackAdvanced = useCallback((pending: boolean) => trackCreation("advanced", pending), [trackCreation]);
  const trackConsent = useCallback((pending: boolean) => trackCreation("consent", pending), [trackCreation]);
  const trackItemWrite = useCallback((owner: symbol, planId: number, pending: boolean): boolean => {
    const current = projection.current;
    const plan = current?.plans.find((row) => row.id === planId && row.patientId === patientId);
    if (pending && (!isAuthorityReady() || current?.contextKey !== contextKey || !current.capabilities.canEditPlans || !plan || plan.status !== "active" || Boolean(plan.consentAt) || inFlightRef.current || hasUncertainAttempt() || creationWrites.current.size > 0 || [...itemWrites.current.entries()].some(([key, value]) => key !== owner && value === planId))) return false;
    if (pending) itemWrites.current.set(owner, planId); else itemWrites.current.delete(owner);
    setItemWriteCount(itemWrites.current.size); return true;
  }, [isAuthorityReady, patientId, contextKey, hasUncertainAttempt]);
  const retireDeniedProjection = useCallback(() => {
    readyContext.current = null; projection.current = null; focusCasesRef.current = null;
    openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false, payFor: null, consentFor: null };
    setAppointmentVisibility("unknown");
    setPlans([]); setPlannedVisits([]); setCapabilities(NO_PATIENT_PLAN_CAPABILITIES); setCanSeeFinancial(false); setLoadedContextKey(null);
    setCreating(false); setQuickCreating(false); setAgreementCreating(false); setFromTemplate(false);
    setConsentFor(null); setPayFor(null); setPayAmount(""); setLastReceipt(null); setFocusCases(null); setFocusLoaded(false);
    itemActivities.current.clear();
    // creationWrites/itemWrites/inFlightRef are intentionally not cleared:
    // denial of a read says nothing about a mutation already in flight.
  }, []);

  useEffect(() => { retireDeniedProjection(); }, [contextKey, retireDeniedProjection]);
  const publishError = useCallback((message: string | null) => { if (isCurrentContext()) setError(message); }, [isCurrentContext]);
  const load = useCallback(async () => {
    if (!isCurrentContext()) return;
    // A session/permission change invalidates the previous projection.
    void authorityKey;
    const sequence = ++loadSequence.current;
    reading.current = true; readyContext.current = null;
    setLoading(true); setFocusLoaded(false); setFocusCases(null); focusCasesRef.current = null;
    try {
      const response = await fetch(`/api/patients/${patientId}/plans`, { cache: "no-store" });
      if (sequence !== loadSequence.current || !isCurrentContext()) return;
      // Authorization denial revokes the visible projection before parsing its
      // body; a malformed/HTML denial is not a harmless transient refresh error.
      if (!response.ok && (response.status === undefined || [401, 403, 404].includes(response.status))) {
        retireDeniedProjection();
      }
      const payload = await response.json().catch(() => null);
      if (sequence !== loadSequence.current || !isCurrentContext()) return;
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      if (!Array.isArray(payload?.plans)) throw new Error("تعذّر قراءة بيانات الخطط كاملة.");
      if (payload.plans.some((plan: Plan) => plan.patientId !== patientId)) { retireDeniedProjection(); throw new Error("بيانات الخطط لا تطابق المريض الحالي."); }
      if (focus?.caseId !== undefined || onFocus) {
        const contextResponse = await fetch(`/api/patients/${patientId}/cases`, { cache: "no-store" });
        if (sequence !== loadSequence.current || !isCurrentContext()) return;
        const contextDenied = !contextResponse.ok && (contextResponse.status === undefined || [401, 403, 404].includes(contextResponse.status));
        if (contextDenied) retireDeniedProjection();
        const context = await contextResponse.json().catch(() => null);
        if (sequence !== loadSequence.current || !isCurrentContext()) return;
        if (contextDenied) throw new Error(context?.message ?? "تعذّر تأكيد الوصول إلى الحالة المرتبطة.");
        if (contextResponse.ok && Array.isArray(context?.cases) && Array.isArray(context?.items)) { focusCasesRef.current = context; setFocusCases(context); }
      }
      setPlans(payload.plans as Plan[]);
      setPlannedVisits(Array.isArray(payload.plannedVisits) ? payload.plannedVisits : []);
      setAppointmentVisibility(readPatientAppointmentVisibility(payload.appointmentVisibility));
      setCanSeeFinancial(payload.canSeeFinancial === true);
      const access = payload.capabilities;
      const nextCapabilities: PatientPlanCapabilities = {
        canEditPlans: access?.canEditPlans === true,
        canViewCatalogPrices: access?.canViewCatalogPrices === true,
        canCollectPayments: access?.canCollectPayments === true,
        canRecordConsent: access?.canRecordConsent === true,
        canCompletePlan: access?.canCompletePlan === true,
        canPrintContract: access?.canPrintContract === true,
      };
      projection.current = { contextKey, plans: payload.plans, capabilities: nextCapabilities };
      // A successful refresh can revoke a capability too. Retire only editors
      // that are no longer reachable; unrelated same-context drafts stay owned.
      if (!nextCapabilities.canEditPlans) {
        setCreating(false); setQuickCreating(false); setAgreementCreating(false); setFromTemplate(false);
        openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
      } else if (!nextCapabilities.canViewCatalogPrices) {
        setCreating(false); setQuickCreating(false);
        openForms.current = { ...openForms.current, creating: false, quickCreating: false };
      }
      if (!nextCapabilities.canRecordConsent || !payload.plans.some((plan: Plan) => plan.id === openForms.current.consentFor && plan.financialVisible && plan.status === "active" && !plan.consentAt)) {
        setConsentFor(null); openForms.current.consentFor = null;
      }
      if (!nextCapabilities.canCollectPayments || !payload.plans.some((plan: Plan) => plan.id === openForms.current.payFor && plan.financialVisible && plan.status === "active" && plan.hasInstallments)) {
        setPayFor(null); setPayAmount(""); openForms.current.payFor = null;
      }
      setCapabilities(nextCapabilities);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setLoadedContextKey(contextKey); readyContext.current = contextKey; reviewedRead.current = { contextKey, sequence }; setReadError(false);
      setLoadedFocusKey(patientRecordFocusKey(focus ?? null));
      setFocusLoaded(true);
      setError(null);
    } catch (loadError) {
      if (sequence !== loadSequence.current || !isCurrentContext()) return;
      readyContext.current = null; setReadError(true);
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (sequence === loadSequence.current && isCurrentContext()) { reading.current = false; setLoading(false); }
    }
  }, [patientId, authorityKey, contextKey, focus, onFocus, retireDeniedProjection, isCurrentContext]);

  useEffect(() => {
    const requests = loadSequence;
    void load();
    return () => { ++requests.current; };
  }, [load]);

  /* (FIN-1) مفتاح إعادة لكل محاولة تحصيل — كما في CollectPaymentModal: انقطاع الرد ثم ضغطٌ
     ثانٍ بالمبلغ نفسه يرسل المفتاح نفسه فيُعاد السند الأول لا يُنشأ ثانٍ. تغيير المبلغ أو
     العملة أو الخطة طلبٌ جديد بمفتاحٍ جديد، ويُمسح المفتاح بعد النجاح. والـref (لا الحالة)
     يمنع إرسالين قبل إعادة الرسم. */
  const attemptRef = useRef<{ target: string; key: string } | null>(null);
  const inFlightRef = useRef(false);

  const leave = useCallback(() => {
    if (!mounted.current) return false;
    if (inFlightRef.current || creationWrites.current.size > 0 || itemWrites.current.size > 0 || [...itemActivities.current.values()].some((state) => state.busy)) return false;
    const forms = openForms.current;
    if (forms.contextKey === currentContext.current && (forms.creating || forms.quickCreating || forms.agreementCreating || forms.fromTemplate || forms.payFor !== null || forms.consentFor !== null)) {
      setError("احفظ النموذج المفتوح أو أغلقه قبل الانتقال إلى سجل آخر."); return false;
    }
    const uncertain = [...uncertainAttempts.current.values()].some((attempt) => attempt.patientId === currentPatient.current);
    const dirty = [...itemActivities.current.values()].some((state) => state.dirty);
    if (dirty || uncertain) {
      const message = uncertain ? `${dirty ? "هناك بند خطة غير محفوظ أيضًا. " : ""}نتيجة طلب سابق غير مؤكدة وقد يكون حُفظ. مغادرة الصفحة أو إعادة تحميلها قد تفقد التحذير المحلي؛ راجع السجل قبل أي إدخال جديد. هل تريد المتابعة${dirty ? " وتجاهل المسودة" : ""}؟` : "هناك بند خطة غير محفوظ. هل تريد تجاهل التعديلات؟";
      if (!window.confirm(message)) return false;
      if (dirty) { itemActivities.current.clear(); setItemsEpoch((value) => value + 1); }
    }
    return true;
  }, []);
  useLayoutEffect(() => { onNavigationGuardChange?.(leave); return () => onNavigationGuardChange?.(null); }, [leave, onNavigationGuardChange]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const warn = (event: BeforeUnloadEvent) => {
      const forms = openForms.current;
      if (inFlightRef.current || creationWrites.current.size > 0 || itemWrites.current.size > 0 || [...uncertainAttempts.current.values()].some((attempt) => attempt.patientId === currentPatient.current) || (forms.contextKey === currentContext.current && (forms.creating || forms.quickCreating || forms.agreementCreating || forms.fromTemplate || forms.payFor !== null || forms.consentFor !== null)) || [...itemActivities.current.values()].some((state) => state.dirty || state.busy)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener?.("beforeunload", warn); return () => window.removeEventListener?.("beforeunload", warn);
  }, []);
  const focused = focus && focusLoaded && loadedFocusKey === patientRecordFocusKey(focus) && !loading ? resolvePlanItemFocus<Plan["items"][number]>(patientId, focus, plans, focusCases) : null;


  const canPublishMutation = () => isCurrentContext() && projection.current?.contextKey === contextKey;
  const mutationChanged = () => { if (canPublishMutation()) void load(); };
  const denyMutationAccess = (status: number) => {
    if (!isCurrentContext()) return;
    ++loadSequence.current; reading.current = false;
    retireDeniedProjection(); setLoading(false); setReadError(true);
    setError(status === 404 ? "سجل الخطة غير متاح. أعد التحقق قبل أي كتابة جديدة." : "لم تعد صلاحية الوصول متاحة. أعد التحقق من الجلسة.");
  };
  const hasPendingWrite = () => inFlightRef.current || creationWrites.current.size > 0 || itemWrites.current.size > 0;
  const canChangeForm = (kind?: string, closing = false) => isCurrentContext() && !hasPendingWrite() && (closing || (isAuthorityReady() && (!kind || creationAllowed(kind))));
  const currentUncertain = [...uncertainAttempts.current.entries()].filter(([, attempt]) => attempt.patientId === patientId);
  const displayedUncertaintyReview = reviewedRead.current;
  const displayedUncertainty = currentUncertain.map(([token]) => token);
  const uncertaintyReviewed = currentUncertain.length > 0 && isAuthorityReady() && reviewedRead.current.contextKey === contextKey
    && currentUncertain.every(([, attempt]) => reviewedRead.current.sequence >= attempt.reviewAfter);
  const acknowledgeNewIntent = () => {
    const attempts = [...uncertainAttempts.current.entries()].filter(([, attempt]) => attempt.patientId === patientId);
    if (reviewedRead.current !== displayedUncertaintyReview || attempts.length !== displayedUncertainty.length || attempts.some(([token]) => !displayedUncertainty.includes(token))) return;
    if (!isAuthorityReady() || hasPendingWrite() || reviewedRead.current.contextKey !== contextKey || !attempts.length || attempts.some(([, attempt]) => reviewedRead.current.sequence < attempt.reviewAfter)) return;
    if (!window.confirm("قد يكون الطلب السابق حُفظ فعلًا. هل راجعت السجل الحالي وتريد بدء إدخال جديد مستقل؟ قد يكرر العمل إذا لم تتحقق منه. ستُمسح مسودة المحاولة غير المحسومة فقط؛ لا توجد إعادة تلقائية.")) return;
    const affectedPlans = new Set(attempts.filter(([, attempt]) => attempt.kind === "item").map(([, attempt]) => attempt.planId).filter((id): id is number => id !== undefined));
    if (affectedPlans.size) setItemRecovery((current) => {
      const next = { ...current }; for (const id of affectedPlans) { next[id] = (next[id] ?? 0) + 1; itemActivities.current.delete(id); } return next;
    });
    if (attempts.some(([, attempt]) => attempt.kind === "create")) {
      setRecoveryEpoch((value) => value + 1); setCreating(false); setQuickCreating(false); setAgreementCreating(false); setFromTemplate(false);
      openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
    }
    if (attempts.some(([, attempt]) => attempt.kind === "consent" && attempt.planId === openForms.current.consentFor)) {
      setConsentFor(null); openForms.current.consentFor = null;
    }
    for (const [token] of attempts) uncertainAttempts.current.delete(token);
    refreshUncertainty((value) => value + 1);
  };
  const collect = async (plan: Plan) => {
    if (!capabilities.canCollectPayments || !plan.financialVisible || !projection.current?.capabilities.canCollectPayments || latestPlan(plan.id)?.status !== "active" || busy || hasPendingWrite() || hasUncertainAttempt() || !isAuthorityReady()) return;
    const body = JSON.stringify({ amount: payAmount, currency: payCurrency });
    const target = `${plan.id}:${body}`;
    if (attemptRef.current?.target !== target) {
      attemptRef.current = { target, key: newIdempotencyKey("inst") };
    }
    inFlightRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/plans/${plan.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attemptRef.current.key },
        body,
      });
      const payload = await response.json().catch(() => null);
      if (!isAuthorityReady()) return;
      if (!response.ok) { setError(payload?.message ?? "تعذّر التحصيل."); return; }
      attemptRef.current = null;
      setLastReceipt((payload as { paymentId: number }).paymentId);
      setPayFor(null);
      setPayAmount("");
      setError(null);
      await load();
    } catch {
      if (isCurrentContext()) setError("تعذّر الاتصال بالخادم. أعد المحاولة — لن يُسجَّل القسط مرتين.");
    } finally {
      inFlightRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div>
      {currentUncertain.length > 0 ? <section role="alert" data-testid="plan-write-uncertain" className="mb-3 rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
        <p>نتيجة طلب سابق غير مؤكدة؛ قد يكون حُفظ بالفعل. لن يُعاد إرساله تلقائيًا، ولا يُسمح بكتابة جديدة قبل مراجعة السجل ثم تأكيد نية جديدة.</p>
        <p className="mt-1 text-xs">هذه حماية مؤقتة داخل الصفحة وليست ضمانًا من الخادم ضد التكرار. إعادة تحميل الصفحة أو فتحها من جديد قد تفقد هذا التنبيه؛ تحقّق من السجل قبل أي إدخال.</p>
        <button type="button" data-testid="plan-review-uncertain" disabled={loading || hasPendingWrite()} onClick={() => { if (!hasPendingWrite()) void load(); }} className="mt-2 rounded-lg border px-3 py-2 font-bold">حدّث السجل للمراجعة</button>
        <button type="button" data-testid="plan-new-intent" disabled={!uncertaintyReviewed || hasPendingWrite()} onClick={acknowledgeNewIntent} className="ms-2 mt-2 rounded-lg border px-3 py-2 font-bold">راجعت السجل؛ ابدأ إدخالًا جديدًا</button>
      </section> : null}
      {focus ? <p role="status" data-testid={focused?.status === "ready" ? "plan-focus-ready" : "plan-focus-unavailable"} className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
        {focused?.status === "ready" ? `البند المحدد #${focus.itemId} في الخطة #${focus.planId}` : focused?.status === "unavailable" && focused.reason === "history_unavailable" ? "البند ملغى؛ عرضه التاريخي غير متاح في هذا القسم. لم يُختَر بند بديل." : loading ? "جارٍ التحقق من البند المحدد وصلاحية الوصول إليه…" : "البند المحدد غير متاح أو لا يطابق الخطة والحالة والسنّ في القراءة الحالية. لم يُختَر بند بديل."}
      </p> : null}
      {readError ? <button type="button" disabled={loading} onClick={() => void load()} className="mb-3 rounded-lg border px-3 py-2 text-sm">إعادة التحقق</button> : null}
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-red-700 text-red-700">{error}</p>
      ) : null}

      {capabilities.canCollectPayments && lastReceipt ? (
        <div className="mb-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّل القسط.</p>
          <div className="flex flex-wrap items-start justify-center gap-2">
            <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
              onClick={() => setLastReceipt(null)}
              className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
              اطبع السند
            </a>
            {/* (RC-2) قسطٌ بمبلغٍ خطأ يُصحَّح هنا — ويبقى على خطته وفاتورته. */}
            <ReceiptCorrectionLauncher key={lastReceipt} paymentId={lastReceipt} patientId={patientId} label="المبلغ خطأ؟ صحّح السند"
              onDone={(_message, replacementId) => { if (!isAuthorityReady()) return; setLastReceipt(replacementId); void load(); }} />
          </div>
        </div>
      ) : null}

      {/* المداخل الواضحة: السرعة أولًا، والتعقيد عند الحاجة. كلها تنتهي إلى محرك V2 نفسه. */}
      {capabilities.canEditPlans ? <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {capabilities.canViewCatalogPrices ? <button
          onClick={() => {
            if (!canChangeForm("quick", openForms.current.quickCreating)) return;
            const nextOpen = !openForms.current.quickCreating;
            openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
            openForms.current.quickCreating = nextOpen;
            setQuickCreating(nextOpen);
            setAgreementCreating(false); setFromTemplate(false); setCreating(false);
          }}
          className="w-full rounded-2xl border-2 border-sky-300 bg-sky-50 py-2.5 text-sm font-extrabold text-sky-800"
        >
          {quickCreating ? "إغلاق الخطة السريعة" : "⚡ خطة سريعة"}
        </button> : null}
        <button
          onClick={() => {
            if (!canChangeForm("agreement", openForms.current.agreementCreating)) return;
            const nextOpen = !openForms.current.agreementCreating;
            openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
            openForms.current.agreementCreating = nextOpen;
            setAgreementCreating(nextOpen);
            setQuickCreating(false); setFromTemplate(false); setCreating(false);
          }}
          className="w-full rounded-2xl border-2 border-violet-300 bg-violet-50 py-2.5 text-sm font-extrabold text-violet-800"
        >
          {agreementCreating ? "إغلاق الاتفاق" : "🦷 تقويم / مبلغ متفق"}
        </button>
        <button
          onClick={() => {
            if (!canChangeForm("template", openForms.current.fromTemplate)) return;
            const nextOpen = !openForms.current.fromTemplate;
            openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
            openForms.current.fromTemplate = nextOpen;
            setFromTemplate(nextOpen);
            setQuickCreating(false); setAgreementCreating(false); setCreating(false);
          }}
          className="w-full rounded-2xl border-2 border-navy-800 bg-white py-2.5 text-sm font-extrabold text-navy-800"
        >
          {fromTemplate ? "إغلاق القوالب" : "📋 قالب تخصص"}
        </button>
        {capabilities.canViewCatalogPrices ? <button
          onClick={() => {
            if (!canChangeForm("advanced", openForms.current.creating)) return;
            const nextOpen = !openForms.current.creating;
            openForms.current = { ...openForms.current, creating: false, quickCreating: false, agreementCreating: false, fromTemplate: false };
            openForms.current.creating = nextOpen;
            setCreating(nextOpen);
            setQuickCreating(false); setAgreementCreating(false); setFromTemplate(false);
          }}
          className="w-full rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white"
        >
          {creating ? "إغلاق المتقدمة" : "⚙️ خطة متقدمة"}
        </button> : null}
      </div> : null}

      {capabilities.canEditPlans && capabilities.canViewCatalogPrices && quickCreating ? (
        <QuickPlanForm key={`${contextKey}:${recoveryEpoch}`} onUncertain={() => markUncertain("create")} onAccessDenied={denyMutationAccess}
          patientId={patientId} base={base} onBusyChange={trackQuick}
          onSaved={() => { if (!isCurrentContext()) return; openForms.current.quickCreating = false; setQuickCreating(false); mutationChanged(); }}
          onError={publishError}
          onAdvanced={() => { if (!canChangeForm("advanced")) return; openForms.current.quickCreating = false; openForms.current.creating = true; setQuickCreating(false); setCreating(true); }}
        />
      ) : null}

      {capabilities.canEditPlans && agreementCreating ? (
        <QuickAgreementPlanForm key={`${contextKey}:${recoveryEpoch}`} onUncertain={() => markUncertain("create")} onAccessDenied={denyMutationAccess}
          patientId={patientId} base={base} onBusyChange={trackAgreement}
          onSaved={() => { if (!isCurrentContext()) return; openForms.current.agreementCreating = false; setAgreementCreating(false); mutationChanged(); }}
          onError={publishError}
        />
      ) : null}

      {capabilities.canEditPlans && fromTemplate ? (
        <TemplatePlanForm canViewCatalogPrices={capabilities.canViewCatalogPrices} key={`${contextKey}:${recoveryEpoch}`} onUncertain={() => markUncertain("create")} onAccessDenied={denyMutationAccess}
          patientId={patientId} base={base} onBusyChange={trackTemplate}
          onSaved={() => { if (!isCurrentContext()) return; openForms.current.fromTemplate = false; setFromTemplate(false); mutationChanged(); }}
          onError={publishError}
        />
      ) : null}

      {capabilities.canEditPlans && capabilities.canViewCatalogPrices && creating ? (
        <NewPlanFormV2 key={`${contextKey}:${recoveryEpoch}`} onUncertain={() => markUncertain("create")} onAccessDenied={denyMutationAccess}
          patientId={patientId} base={base} busy={busy || loading || readError} onBusyChange={trackAdvanced}
          onSaved={() => { if (!isCurrentContext()) return; openForms.current.creating = false; setCreating(false); mutationChanged(); }}
          onError={publishError}
        />
      ) : null}

      {loading && plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : plans.length === 0 && readError ? (
        <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-900">الخطط غير متاحة من القراءة الحالية؛ لا يمكن تأكيد وجود خطط أو عدمها.</p>
      ) : plans.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا خطط علاج بعد. أنشئ خطةً واحدة يُوزَّع علاجها على الجلسات والزيارات تلقائيًا.
        </p>
      ) : (
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.id} className={`rounded-2xl border p-4 ${
              plan.status === "active" ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
            }`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-base font-extrabold">{plan.title}</span>
                <span className="flex items-center gap-1.5">
                  {!plan.consentAt ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">موافقة العلاج لم تُسجّل</span>
                  ) : null}
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                    {PLAN_STATUS_LABEL[plan.status]}
                  </span>
                </span>
              </div>

              {canSeeFinancial && plan.financialVisible ? <div className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-slate-50 p-2">
                  <p className="text-sm font-bold">{formatMoney(plan.totalMinor, plan.baseCurrency)}</p>
                  <p className="text-[11px] text-slate-500">
                    {plan.installments.length > 0 ? "الإجمالي" : "المتفق عليه"}
                  </p>
                </div>
                {plan.installments.length > 0 && canSeeFinancial ? (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.progress.paidMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-emerald-700">المدفوع</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(plan.progress.remainingMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-slate-500">الباقي</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-xl bg-emerald-50 p-2">
                      <p className="text-sm font-extrabold text-emerald-800">{formatMoney(plan.itemsProgress.doneMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-emerald-700">أُنجز</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-2">
                      <p className="text-sm font-bold">{formatMoney(plan.itemsProgress.remainingMinor, plan.baseCurrency)}</p>
                      <p className="text-[11px] text-slate-500">باقي العلاج</p>
                    </div>
                  </>
                )}
              </div> : (
                <p className="mb-2 rounded-xl bg-slate-50 p-2 text-xs text-slate-600">
                  أُنجز {plan.itemsProgress.doneCount} من {plan.itemsProgress.count} بنود · التفاصيل المالية غير متاحة
                  {plan.hasInstallments ? " · لهذه الخطة اتفاق أقساط" : ""}
                </p>
              )}

              {canSeeFinancial && plan.financialVisible && plan.installments.length > 0 ? (
                <>
                  <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full bg-emerald-500"
                      style={{ width: `${Math.min(100, Math.round((plan.progress.paidMinor / Math.max(1, plan.totalMinor)) * 100))}%` }} />
                  </div>
                  <p className="mb-2 text-[11px] text-slate-500">
                    {plan.progress.paidCount} من {plan.progress.count} أقساط
                    {plan.progress.nextDueDate ? ` · القادم ${friendlyDateLong(plan.progress.nextDueDate)}` : ""}
                    {" · "}
                    <span>سنداتها فواتير ودفعات في تبويب كشف الحساب</span>
                  </p>
                </>
              ) : null}

              {canSeeFinancial && plan.financialVisible && plan.progress.overdueMinor > 0 ? (
                <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
                  متأخر: {formatMoney(plan.progress.overdueMinor, plan.baseCurrency)}
                </p>
              ) : null}

              {canSeeFinancial && plan.financialVisible && plan.status === "active" && plan.hasInstallments && (capabilities.canCollectPayments || capabilities.canCompletePlan || capabilities.canPrintContract) ? (
                capabilities.canCollectPayments && payFor === plan.id ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex flex-wrap gap-2">
                      <input value={payAmount} onChange={(event) => { if (!inFlightRef.current) setPayAmount(event.target.value); }} disabled={busy}
                        placeholder="مبلغ القسط" aria-label="مبلغ القسط" inputMode="decimal" dir="ltr" autoFocus
                        className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                      <select value={payCurrency} onChange={(event) => { if (!inFlightRef.current) setPayCurrency(event.target.value as Currency); }} disabled={busy}
                        aria-label="العملة"
                        className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
                        {CURRENCIES.map((currency) => (
                          <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => collect(plan)} disabled={busy || creationBusy || itemWriteCount > 0 || loading || readError || !payAmount.trim()}
                        className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                        سجّل القسط واطبع السند
                      </button>
                      <button onClick={() => { if (canChangeForm(undefined, true)) { openForms.current.payFor = null; setPayFor(null); } }}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
                        إلغاء
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {capabilities.canCollectPayments ? <button
                      onClick={() => {
                        if (!canChangeForm() || !projection.current?.capabilities.canCollectPayments || latestPlan(plan.id)?.status !== "active") return;
                        openForms.current.payFor = plan.id; setPayFor(plan.id);
                        // المقترح: القسط القادم — أكثر ما يُدفع فعلًا.
                        const suggested = plan.progress.nextDueAmountMinor || plan.installments[0]?.amountMinor || 0;
                        setPayAmount(suggested ? toInputAmount(suggested, plan.baseCurrency) : "");
                        // (TD-05) التحصيل يبدأ بعملة الاتفاق — والاختيار يبقى للمحصِّل.
                        setPayCurrency(plan.baseCurrency);
                      }}
                      className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white">
                      تحصيل قسط
                    </button> : null}
                    {capabilities.canCompletePlan ? <button
                      disabled={busy || creationBusy || itemWriteCount > 0 || hasUncertainAttempt() || loading || readError}
                      onClick={async () => {
                        if (busy || !capabilities.canCompletePlan || !projection.current?.capabilities.canCompletePlan || latestPlan(plan.id)?.status !== "active" || hasPendingWrite() || hasUncertainAttempt() || !isAuthorityReady()) return;
                        inFlightRef.current = true; setBusy(true); setError(null);
                        try {
                          const response = await fetch(`/api/plans/${plan.id}`, {
                            method: "PATCH", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ status: "completed" }),
                          });
                          const payload = await response.json().catch(() => null);
                          if (!isAuthorityReady()) return;
                          if (!response.ok) { setError(payload?.message ?? "تعذّر إنهاء الخطة."); return; }
                          await load();
                        } catch { if (isCurrentContext()) setError("تعذّر الاتصال بالخادم. لم يُؤكَّد إنهاء الخطة."); }
                        finally { inFlightRef.current = false; if (mounted.current) setBusy(false); }
                      }}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
                      إنهاء الخطة
                    </button> : null}
                    {capabilities.canPrintContract ? <a
                      href={`/print/plan/${plan.id}`} target="_blank" rel="noopener noreferrer"
                      className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-navy-800"
                    >طباعة العقد</a> : null}
                  </div>
                )
              ) : null}

              {plan.items.length > 0 || (plan.status === "active" && !plan.consentAt) ? (
                <PlanItems key={`${contextKey}:${plan.id}:${itemsEpoch}:${itemRecovery[plan.id] ?? 0}`} plan={plan} onReviewWork={onFocus && openVisitId !== null && focusCases?.planVisible === true ? (item) => {
                  if (!isAuthorityReady() || currentOpenVisit.current !== openVisitId) return;
                  const context = focusCasesRef.current;
                  const currentPlan = latestPlan(plan.id);
                  const currentItems = currentPlan?.items.filter((row) => row.id === item.id) ?? [];
                  const currentItem = currentItems.length === 1 ? currentItems[0] : null;
                  const links = context?.planVisible === true ? context.items.filter((row) => row.id === item.id) : [];
                  const link = links.length === 1 ? links[0] : null;
                  const ownedCase = link?.caseId === null || context?.cases.filter((row) => row.id === link?.caseId && row.patientId === patientId).length === 1;
                  if (currentPlan?.status === "active" && currentItem && ["planned", "in_progress"].includes(currentItem.status) && currentItem.toothCode === item.toothCode && link?.planId === plan.id && link.toothCode === item.toothCode && ownedCase) onFocus({ kind: "visit_work", patientId, visitId: openVisitId, planId: plan.id, itemId: item.id, caseId: link.caseId, toothCode: item.toothCode });
                  else setError("تعذّر تأكيد ارتباط البند. حدّث الخطة قبل مراجعة الزيارة.");
                } : undefined} onUncertain={() => markUncertain("item", plan.id)} onAccessDenied={denyMutationAccess} canPublishMutation={canPublishMutation} focusItemId={focused?.status === "ready" && focus?.planId === plan.id ? focus.itemId : undefined} onActivityChange={trackItemActivity} onWritePendingChange={trackItemWrite} canSubmit={isAuthorityReady} readPending={loading || readError} canSeeFinancial={canSeeFinancial && plan.financialVisible}
                  canEditPlans={capabilities.canEditPlans} canViewCatalogPrices={capabilities.canViewCatalogPrices}
                  onChanged={mutationChanged} onError={publishError} />
              ) : null}

              {capabilities.canRecordConsent && plan.financialVisible && plan.status === "active" && !plan.consentAt && (plan.items.length > 0 || !plan.totalFromItems && plan.totalMinor > 0) ? (
                consentFor === plan.id ? (
                  <ConsentForm key={`${contextKey}:${plan.id}:${recoveryEpoch}`} plan={plan} onUncertain={() => markUncertain("consent", plan.id)} onAccessDenied={denyMutationAccess} canPublishMutation={canPublishMutation} canSubmit={() => isAuthorityReady() && creationAllowed("consent") && latestPlan(plan.id)?.status === "active" && !latestPlan(plan.id)?.consentAt} readPending={loading || readError} onBusyChange={trackConsent} onCancel={() => { if (creationWrites.current.size === 0) { openForms.current.consentFor = null; setConsentFor(null); } }}
                    onDone={() => { if (!isCurrentContext()) return; openForms.current.consentFor = null; setConsentFor(null); mutationChanged(); }} onError={publishError} />
                ) : (
                  <button disabled={creationBusy || busy || loading || readError} onClick={() => { if (!hasPendingWrite() && isAuthorityReady() && creationAllowed("consent") && latestPlan(plan.id)?.status === "active" && !latestPlan(plan.id)?.consentAt) { openForms.current.consentFor = plan.id; setConsentFor(plan.id); } }}
                    className="mt-2 w-full rounded-xl border border-emerald-500 bg-emerald-50 py-2 text-xs font-extrabold text-emerald-800">
                    سجّل موافقة المريض — ويُقفل الاتفاق
                  </button>
                )
              ) : null}

              {plan.consentAt ? (
                <p className="mt-2 text-[10px] font-semibold text-slate-400">
                  وافق المريض في {friendlyDateLong(plan.consentAt.slice(0, 10))}
                  {plan.consentBy ? ` · سجّلها ${plan.consentBy}` : ""}
                  {plan.consentNote ? ` · ${plan.consentNote}` : ""}
                </p>
              ) : null}

              {canSeeFinancial && plan.financialVisible && plan.installments.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-bold text-slate-500">جدول الأقساط</summary>
                <ul className="mt-2 space-y-1">
                  {plan.installments.map((installment) => (
                    <li key={installment.id} className="flex justify-between gap-2 text-xs">
                      <span className={installment.number <= plan.progress.paidCount ? "text-emerald-700" : "text-slate-600"}>
                        {installment.number <= plan.progress.paidCount ? "✓ " : ""}
                        قسط {installment.number} · {friendlyDateLong(installment.dueDate)}
                      </span>
                      <span className="font-bold">{formatMoney(installment.amountMinor, plan.baseCurrency)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* الزيارات المخطَّطة — توزيع الخطة على الزيارات (المواصفة §١٠) */}
      {plannedVisits.length > 0 ? (
        <section className="mt-4" aria-label="توزيع الخطة على الزيارات">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            توزيع الخطة على الزيارات ({plannedVisits.length})
          </h3>
          <ul className="space-y-1.5">
            {plannedVisits.map((visit) => (
              <li key={visit.id} data-appointment-visibility={visit.appointmentVisibility} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-navy-900">
                    زيارة {visit.sequence}: {visit.title}
                    {visit.planTitle ? <span className="font-normal text-slate-500"> · {visit.planTitle}</span> : null}
                  </span>
                  <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                    {PLANNED_VISIT_STATUS_LABEL[visit.status]} · {visit.durationMinutes} دقيقة
                  </span>
                </div>
                {visit.appointmentDate ? (
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    محجوزة {friendlyDateLong(visit.appointmentDate)} · {visit.appointmentTime}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {patientPlanAppointmentEmptyText(visit)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * نموذج الخطة الموحَّد — الرحلة V2.
 *
 * الأقسام الثلاثة (§٧): البيانات، البنود العلاجية بقواعد الفوترة وجلساتها، ثم
 * طريقة التسعير وطريقة الدفع. والإجمالي يُشتقّ من البنود حيثما وُجدت بنود —
 * رقمان لعملٍ واحد هما بذرة كل خلافٍ لاحق مع المريض.
 */
function NewPlanFormV2({ patientId, base, busy, onSaved, onError, onBusyChange, onUncertain, onAccessDenied }: {
  patientId: number; base: Currency; busy: boolean; onBusyChange?: (pending: boolean) => boolean | void;
  onUncertain?: () => void; onAccessDenied?: (status: number) => void;
  onSaved: () => void; onError: (message: string | null) => void;
}) {
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  /* (TD-05) عملة الاتفاق — اختيارٌ صريح لا فرضٌ صامت: مريض التقويم قد يتعاقد
     بالدولار أو السعودي، والقائمة تعرض الثلاثة، والافتراضي هو العملة الأساسية. */
  const [currency, setCurrency] = useState<Currency>(base);
  const [title, setTitle] = useState("خطة علاج ترميمي");
  const [specialty, setSpecialty] = useState(SPECIALTIES[0]);
  const [doctorId, setDoctorId] = useState<string>("");
  const [startDate, setStartDate] = useState(today);
  const [rows, setRows] = useState<PlanItemDraftRow[]>([]);
  const [pricingMode, setPricingMode] = useState<"items" | "agreed">("items");
  const [agreedTotal, setAgreedTotal] = useState("");
  const [paymentMode, setPaymentMode] = useState<"per_procedure" | "installments" | "custom">("per_procedure");
  const [installmentCount, setInstallmentCount] = useState("12");
  const [everyDays, setEveryDays] = useState("30");
  const [customInstallments, setCustomInstallments] = useState<{ dueDate: string; amount: string }[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const uncertain = useRef(false);
  const mounted = useRef(false);
  // Retained handlers lose authority at the unmount commit, before passive cleanup.
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
      const [serviceResponse, doctorResponse] = await Promise.all([
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/parties?kind=doctor", { cache: "no-store" }),
      ]);
      if (!active) return;
      if (serviceResponse.ok) {
        const payload = await serviceResponse.json();
        if (active) setServices((payload.services ?? payload) as Service[]);
      }
      if (doctorResponse.ok) {
        const payload = await doctorResponse.json();
        if (active) setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      }
      } catch { /* Auxiliary catalogs are unavailable; do not replace a draft. */ }
    })();
    return () => { active = false; };
  }, []);

  const itemsTotalMinor = rows.reduce((sum, row) => {
    const service = services.find((item) => String(item.id) === row.serviceId);
    const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
    const unit = typed ?? (currency === base && service ? service.priceMinor : 0);
    return sum + unit * Math.max(1, Math.round(Number(row.quantity) || 1));
  }, 0);
  const agreedTotalMinor = pricingMode === "agreed" ? (parseAmount(agreedTotal, currency) ?? 0) : 0;
  const planTotalMinor = pricingMode === "items" ? itemsTotalMinor : agreedTotalMinor;

  const previewInstallments = paymentMode === "installments" && planTotalMinor > 0
    ? splitInstallments(planTotalMinor, Number(installmentCount) || 1, startDate, Number(everyDays) || 30)
    : [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mounted.current || uncertain.current || inFlight.current || saving || busy) return;
    onError(null);

    const items = rows
      .filter((row) => row.serviceId)
      .map((row) => {
        const service = services.find((item) => String(item.id) === row.serviceId);
        const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
        return {
          serviceId: Number(row.serviceId),
          serviceName: service?.name ?? "",
          category: service?.category ?? null,
          toothCode: row.tooth.trim() ? Number(row.tooth.trim()) : null,
          surfaces: row.surfaces.trim() || null,
          quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
          // (TD-05) سعر الدليل أساسيّ — لا يُنسخ بعملة اتفاقٍ مختلفة بلا إذن.
          unitPriceMinor: typed ?? (currency === base && service ? service.priceMinor : 0),
          billingRule: row.billingRule,
          sessionCount: Math.max(1, Math.round(Number(row.sessions) || 1)),
          note: null,
          ...(row.priceReason?.trim() ? { priceReason: row.priceReason.trim() } : {}),
        };
      });

    if (items.length === 0 && paymentMode !== "installments" && pricingMode !== "agreed") {
      onError("أضف بندًا واحدًا على الأقل، أو اختر طريقة تسعيرٍ بمبلغٍ متفق عليه.");
      return;
    }

    const installments =
      paymentMode === "installments"
        ? splitInstallments(planTotalMinor, Number(installmentCount) || 1, startDate, Number(everyDays) || 30)
            .map((part) => ({ dueDate: part.dueDate, amountMinor: part.amountMinor }))
        : paymentMode === "custom"
          ? customInstallments
              .map((row) => ({
                dueDate: row.dueDate,
                amountMinor: parseAmount(row.amount, currency) ?? 0,
              }))
              .filter((row) => row.dueDate && row.amountMinor > 0)
          : [];

    const agreementPricing = checkPlanAgreementPricing({
      pricingMode, total: pricingMode === "agreed" ? agreedTotal : undefined, currency, items, installments,
    });
    if (!agreementPricing.ok) {
      onError(agreementPricing.message);
      return;
    }

    if (onBusyChange?.(true) === false) return;
    inFlight.current = true; setSaving(true);
    let saved = false;
    const recordUncertain = () => {
      if (!uncertain.current) { uncertain.current = true; onUncertain?.(); }
      if (mounted.current) onError("نتيجة إنشاء الخطة غير مؤكدة؛ قد تكون حُفظت. راجع السجل قبل أي إدخال جديد.");
    };
    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "v2",
          pricingMode,
          patientId,
          title, specialty,
          currency,
          primaryDoctorId: doctorId ? Number(doctorId) : null,
          startDate,
          note: note.trim() || null,
          items,
          billingMode: paymentMode === "per_procedure" ? "per_procedure"
            : paymentMode === "installments" ? "installments" : "custom_schedule",
          total: pricingMode === "agreed" ? agreedTotal : undefined,
          count: paymentMode === "installments" ? Number(installmentCount) : undefined,
          everyDays: paymentMode === "installments" ? Number(everyDays) : undefined,
          installments: installments.length > 0 ? installments : undefined,
        }),
      });
      if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
      const payload = await response.json().catch(() => null);
      if (response.ok && Number.isSafeInteger(payload?.id) && payload.id > 0) saved = true;
      else if (!response.ok && response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) {
        if (mounted.current) onError(payload?.message ?? "رُفض حفظ الخطة.");
      } else recordUncertain();
    } catch { recordUncertain(); }
    finally {
      inFlight.current = false; onBusyChange?.(false);
      if (mounted.current) setSaving(false);
    }
    if (saved && mounted.current) onSaved();
  };

  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border border-navy-800 bg-white p-4">
      <fieldset disabled={saving || busy || uncertain.current}>
      <h3 className="mb-1 text-sm font-extrabold text-navy-900">خطة علاج جديدة</h3>
      <p className="mb-3 text-[11px] leading-4 text-slate-500">
        تُبنى بالبنود والجلسات والزيارات المخطَّطة في عمليةٍ واحدة. الخطة اتفاقٌ لا
        دَين: لا يدخل الحساب إلا ما نُفِّذ ووُلِّد استحقاقه وفق قاعدة الفوترة.
      </p>

      {/* ١) البيانات */}
      <input value={title} onChange={(event) => { if (!inFlight.current && !uncertain.current && mounted.current) setTitle(event.target.value); }}
        placeholder="اسم الخطة — مثل: علاج ترميمي شامل" aria-label="اسم الخطة"
        className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <div className="mb-3 flex flex-wrap gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">التخصص</span>
          <select value={specialty} onChange={(event) => setSpecialty(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {SPECIALTIES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">الطبيب المعالج</span>
          <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="">—</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
        <label className="w-40">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ البدء</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="w-44">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">عملة الاتفاق</span>
          <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}
            aria-label="عملة الاتفاق"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {CURRENCIES.map((option) => (
              <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
            ))}
          </select>
        </label>
      </div>

      {/* ٢) البنود العلاجية — بقاعدة فوترةٍ وعدد جلسات لكل بند */}
      {rows.map((row, index) => {
        const service = services.find((item) => String(item.id) === row.serviceId);
        const typed = row.price.trim() ? parseAmount(row.price, currency) : null;
        const unit = typed ?? (currency === base && service ? service.priceMinor : 0);
        const sessions = Math.max(1, Math.round(Number(row.sessions) || 1));
        return (
          <div key={index} className="mb-2 space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/50 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[12rem] flex-1">
                <ServiceSelect
                  services={services}
                  value={row.serviceId ? Number(row.serviceId) : null}
                  onChange={(id, srv) => {
                    if (inFlight.current || uncertain.current || !mounted.current) return;
                    setRows((current) => current.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            serviceId: id ? String(id) : "",
                            // (TD-05) بعملة اتفاقٍ مختلفة لا يُقترح سعر الدليل — يُكتب يدويًا.
                            price: currency === base && srv ? formatAmount(srv.priceMinor, base) : "",
                          }
                        : item));
                  }}
                  base={base}
                  placeholder={currency === base ? "— اختر الإجراء من الدليل —" : "— اختر الإجراء ثم اكتب سعره بعملة الاتفاق —"}
                  ariaLabel="الإجراء"
                />
              </div>
              <ToothField value={row.tooth} className="w-20"
                onChange={(tooth) => { if (!inFlight.current && !uncertain.current && mounted.current) setRows((current) => current.map((item, i) => i === index ? { ...item, tooth } : item)); }} />
              <input value={row.quantity} onChange={(event) =>
                setRows((current) => current.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))}
                placeholder="1" aria-label="الكمية" inputMode="numeric" dir="ltr"
                className="w-16 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm" />
              <input value={row.price} onChange={(event) =>
                setRows((current) => current.map((item, i) => i === index ? { ...item, price: event.target.value } : item))}
                placeholder="السعر" aria-label="السعر" inputMode="decimal" dir="ltr"
                className="w-24 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-bold" />
              <button type="button"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm font-bold text-red-500 hover:bg-red-50"
                title="حذف البند">✕</button>
            </div>
            {/* (FIN-5) سعرٌ يخالف الدليل (أو يُكتب بعملة اتفاق) قرارٌ مسبَّب: الخصم في حدّ الإعدادات
                لغير المدير، والرفع للمدير — والخادم يحكم ويدقّق كما في الزيارة والفاتورة. */}
            {service && row.price.trim() && (currency !== base || typed !== service.priceMinor) ? (
              <input value={row.priceReason ?? ""} maxLength={300}
                onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, priceReason: event.target.value } : item))}
                placeholder="سبب تغيير السعر عن الدليل (مثل: خصم عائلة)" aria-label="سبب تغيير السعر"
                className="w-full rounded-xl border border-amber-200 bg-amber-50/40 px-2.5 py-1.5 text-xs" />
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1 font-bold text-slate-600">
                قاعدة الفوترة:
                <select value={row.billingRule}
                  onChange={(event) => setRows((current) => current.map((item, i) =>
                    i === index ? { ...item, billingRule: event.target.value as BillingRule } : item))}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]">
                  {BILLING_RULES.map((rule) => <option key={rule} value={rule}>{BILLING_RULE_LABEL[rule]}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1 font-bold text-slate-600">
                الجلسات:
                <input value={row.sessions} inputMode="numeric" dir="ltr"
                  onChange={(event) => setRows((current) => current.map((item, i) =>
                    i === index ? { ...item, sessions: event.target.value } : item))}
                  className="w-12 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]" />
              </label>
              {unit > 0 && sessions > 1 && row.billingRule === "per_session" ? (
                <span className="text-slate-500">
                  لكل جلسة ≈ {formatAmount(Math.floor(unit / sessions), currency)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-2">
        <button type="button"
          onClick={() => setRows((current) => [
            ...current,
            { serviceId: "", tooth: "", quantity: "1", price: "", sessions: "1", surfaces: "", billingRule: "on_completion" },
          ])}
          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
          + بند علاجي
        </button>
      </div>

      {/* ٣) طريقة التسعير */}
      <fieldset className="mt-3 mb-2 rounded-xl border border-slate-200 p-2.5">
        <legend className="px-1 text-[11px] font-extrabold text-slate-600">طريقة التسعير</legend>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPricingMode("items")}
            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
              pricingMode === "items" ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
            }`}>
            حسب البنود — الإجمالي مشتقّ منها
          </button>
          <button type="button" onClick={() => setPricingMode("agreed")}
            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
              pricingMode === "agreed" ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
            }`}>
            مبلغ إجمالي متفق عليه
          </button>
        </div>
        {pricingMode === "agreed" ? (
          <input value={agreedTotal} onChange={(event) => setAgreedTotal(event.target.value)}
            placeholder="المبلغ الإجمالي المتفق عليه" aria-label="المبلغ المتفق عليه"
            inputMode="decimal" dir="ltr"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
        ) : (
          <p className="mt-1.5 text-[11px] text-slate-500">
            الإجمالي من البنود: <span className="font-extrabold text-navy-900">{formatMoney(itemsTotalMinor, currency)}</span>
          </p>
        )}
      </fieldset>

      {/* ٤) طريقة الدفع */}
      <fieldset className="mb-3 rounded-xl border border-slate-200 p-2.5">
        <legend className="px-1 text-[11px] font-extrabold text-slate-600">طريقة الدفع</legend>
        <div className="flex flex-wrap gap-2">
          {([
            ["per_procedure", "حسب الخدمات المنفَّذة"],
            ["installments", "دفعة أولى + أقساط"],
            ["custom", "جدول دفعات مخصص"],
          ] as const).map(([mode, label]) => (
            <button key={mode} type="button" onClick={() => setPaymentMode(mode)}
              className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold ${
                paymentMode === mode ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {label}
            </button>
          ))}
        </div>

        {paymentMode === "installments" ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={installmentCount} onChange={(event) => setInstallmentCount(event.target.value)}
              placeholder="عدد الأقساط" aria-label="عدد الأقساط" inputMode="numeric" dir="ltr"
              className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <input value={everyDays} onChange={(event) => setEveryDays(event.target.value)}
              placeholder="كل كم يوم" aria-label="المدة بين الأقساط" inputMode="numeric" dir="ltr"
              className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </div>
        ) : null}

        {paymentMode === "custom" ? (
          <div className="mt-2 space-y-1.5">
            {customInstallments.map((row, index) => (
              <div key={index} className="flex gap-2">
                <input type="date" value={row.dueDate}
                  onChange={(event) => setCustomInstallments((current) =>
                    current.map((item, i) => i === index ? { ...item, dueDate: event.target.value } : item))}
                  aria-label="تاريخ الدفعة"
                  className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                <input value={row.amount} inputMode="decimal" dir="ltr"
                  onChange={(event) => setCustomInstallments((current) =>
                    current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))}
                  placeholder="المبلغ" aria-label="مبلغ الدفعة"
                  className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold" />
                <button type="button"
                  onClick={() => setCustomInstallments((current) => current.filter((_, i) => i !== index))}
                  className="rounded-xl border border-slate-200 px-2.5 py-2 text-sm font-bold text-red-500">✕</button>
              </div>
            ))}
            <button type="button"
              onClick={() => setCustomInstallments((current) => [...current, { dueDate: startDate, amount: "" }])}
              className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
              + دفعة
            </button>
          </div>
        ) : null}

        {previewInstallments.length > 0 ? (
          <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            {previewInstallments.length} قسطًا · الأول {formatMoney(previewInstallments[0].amountMinor, currency)} في{" "}
            {friendlyDateLong(previewInstallments[0].dueDate)} · الأخير في{" "}
            {friendlyDateLong(previewInstallments[previewInstallments.length - 1].dueDate)}
          </p>
        ) : null}
      </fieldset>

      <input value={note} onChange={(event) => setNote(event.target.value)}
        placeholder="ملاحظة (اختياري)" aria-label="ملاحظة"
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />

      <p className="mb-3 text-sm font-extrabold text-navy-900">
        إجمالي الخطة: {formatMoney(planTotalMinor, currency)}
      </p>

      <button type="submit" disabled={saving || busy || planTotalMinor <= 0}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        {saving ? "جارٍ الحفظ…" : "أنشئ الخطة بجلساتها وزياراتها"}
      </button>
      </fieldset>
    </form>
  );
}

interface PlanItemDraftRow {
  serviceId: string; tooth: string; quantity: string;
  price: string; sessions: string; surfaces: string; billingRule: BillingRule;
  /** (FIN-5) سبب سعرٍ يخالف الدليل — يطلبه الخادم للخصم أو الرفع. */
  priceReason?: string;
}

/**
 * بنود الخطة — المسوّدة تُبنى، ثم تُقفل بالموافقة.
 *
 * قبل الموافقة: تُضاف البنود وتُحذف بحرّية، والإجمالي يتحرّك معها. وبعدها: قائمةٌ
 * للقراءة تُطبع ويُوقّع عليها المريض. والفرق بين الحالتين ظاهرٌ في الشاشة نفسها —
 * لا في رأس من يستعملها.
 */
function PlanItems({ plan, onReviewWork, focusItemId, onActivityChange, onWritePendingChange, canSubmit, canPublishMutation, onUncertain, onAccessDenied, readPending = false, canSeeFinancial, canEditPlans, canViewCatalogPrices, onChanged, onError }: {
  onReviewWork?: (item: Plan["items"][number]) => void;
  plan: Plan; onWritePendingChange?: (owner: symbol, planId: number, pending: boolean) => boolean | void;
  focusItemId?: number; onActivityChange?: (planId: number, activity: { dirty: boolean; busy: boolean } | null) => void;
  canSubmit?: () => boolean; canPublishMutation?: () => boolean; readPending?: boolean;
  onUncertain?: () => void; onAccessDenied?: (status: number) => void;
  canSeeFinancial: boolean; canEditPlans: boolean; canViewCatalogPrices: boolean;
  onChanged: () => void; onError: (message: string | null) => void;
}) {
  // (TD-05) أسعار بنود هذه الخطة بعملة اتفاقها — لا بعملة الدفاتر.
  const base: Currency = plan.baseCurrency;
  const [services, setServices] = useState<(Omit<Service, "priceMinor"> & { priceMinor?: number | null })[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [tooth, setTooth] = useState("");
  const [surfaces, setSurfaces] = useState("");
  /* تنظيم الجلسات: الجلسة الهدف وعدد جلسات البند وقاعدة فوترته وطبيبه. */
  const [targetVisitNumber, setTargetVisitNumber] = useState("1");
  const [sessionCount, setSessionCount] = useState("1");
  const [billingRule, setBillingRule] = useState<BillingRule>("on_completion");
  const [doctorId, setDoctorId] = useState("");
  /* (TD-05 owner review — Finding 2) سعرٌ صريح بعملة الخطة لبندٍ يُضاف إلى خطة
     بعملة اتفاق — سعر الدليل أساسيّ ولا يُنسخ إليها. */
  const [itemPrice, setItemPrice] = useState("");
  const [itemPriceReason, setItemPriceReason] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const uncertain = useRef(false);
  const draftVersion = useRef(0);
  const [, renderDraftVersion] = useState(0);
  const renderedDraftVersion = draftVersion.current;
  const writeOwner = useRef(Symbol("plan-item-request"));
  const activity = useRef({ dirty: false, busy: false });
  const focusedRow = useRef<HTMLLIElement | null>(null);
  const publishActivity = () => { if (mounted.current) onActivityChange?.(plan.id, { ...activity.current }); };
  const markDirty = () => {
    if (!mounted.current || inFlight.current || uncertain.current) return;
    ++draftVersion.current;
    // Captured descendant events and same-value picker callbacks need an owner
    // render too; otherwise the current buttons retain an obsolete version.
    renderDraftVersion(draftVersion.current);
    activity.current.dirty = true; publishActivity();
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onActivityChange?.(plan.id, null); };
    // Pending request ownership belongs to finally, never to component cleanup.
  }, [plan.id, onActivityChange]);
  useEffect(() => {
    if (focusItemId === undefined) return;
    focusedRow.current?.scrollIntoView?.({ block: "nearest" }); focusedRow.current?.focus?.({ preventScroll: true });
  }, [focusItemId]);
  const locked = Boolean(plan.consentAt) || plan.status !== "active" || !canEditPlans;
  const visitGroups = groupProjectedPlanItems(plan.items);

  useEffect(() => {
    if (locked) return;
    let active = true;
    void (async () => {
      try {
        const [servRes, docRes] = await Promise.all([
          fetch(canViewCatalogPrices ? "/api/services" : "/api/plan-templates", { cache: "no-store" }),
          fetch("/api/parties?kind=doctor", { cache: "no-store" }),
        ]);
        if (!active) return;
        if (servRes.ok) {
          const payload = await servRes.json();
          const list = (payload.services ?? payload) as Service[];
          if (active && Array.isArray(list)) setServices(list);
        }
        if (docRes.ok) {
          const docPayload = await docRes.json();
          if (active) setDoctors(Array.isArray(docPayload) ? docPayload : (docPayload.balances ?? []));
        }
      } catch {
        /* قوائم مساعدة — فشلها لا يعطّل البنود. */
      }
    })();
    return () => { active = false; };
  }, [locked, canViewCatalogPrices]);

  const startWrite = () => {
    if (!mounted.current || renderedDraftVersion !== draftVersion.current || uncertain.current || locked || inFlight.current || readPending || canSubmit?.() === false) return false;
    if (onWritePendingChange?.(writeOwner.current, plan.id, true) === false) return false;
    inFlight.current = true; activity.current.busy = true; publishActivity(); setBusy(true); return true;
  };
  const finishWrite = () => {
    inFlight.current = false;
    onWritePendingChange?.(writeOwner.current, plan.id, false);
    activity.current.busy = false;
    if (mounted.current) { setBusy(false); publishActivity(); }
  };
  const canPublish = () => mounted.current && (canPublishMutation ? canPublishMutation() : canSubmit?.() !== false);
  const recordUncertain = () => {
    if (!uncertain.current) { uncertain.current = true; onUncertain?.(); }
    if (canPublish()) onError("نتيجة طلب البند غير مؤكدة؛ قد يكون حُفظ. راجع السجل قبل أي إدخال جديد.");
  };
  const definitiveRejection = (status: number) => status >= 400 && status < 500 && ![408, 499].includes(status);
  const add = async () => {
    if (!serviceId || !startWrite()) return;
    onError(null);
    let saved = false;
    try {
      const response = await fetch(`/api/plans/${plan.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId, quantity: 1,
          toothCode: tooth.trim() ? Number(tooth.trim()) : null,
          surfaces: surfaces.trim() || null,
          /* (TD-05 owner review) الخطة بعملة اتفاق: السعر الصريح بعملتها.
             والخطة الأساسية يبقى سعرها من الدليل في الخادم — لا يُرسل. */
          ...(base !== CLINIC_BASE_CURRENCY ? { price: itemPrice.trim() || "", priceReason: itemPriceReason.trim() || null } : {}),
          plannedVisitNumber: Math.max(1, Number(targetVisitNumber) || 1),
          sessionCount: Math.max(1, Number(sessionCount) || 1),
          billingRule,
          doctorId: doctorId ? Number(doctorId) : null,
        }),
      });
      if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === "object") saved = true;
      else if (!response.ok && definitiveRejection(response.status)) { if (canPublish()) onError(payload?.message ?? "رُفضت إضافة البند."); }
      else recordUncertain();
    } catch { recordUncertain(); }
    finally { finishWrite(); }
    if (saved) {
      ++draftVersion.current;
      // This acknowledgement remains true during a sibling refresh. Never turn
      // a confirmed saved draft back into a retryable submission.
      activity.current.dirty = false;
      if (mounted.current) {
        setServiceId(null); setTooth(""); setSurfaces(""); setSessionCount("1");
        setItemPrice(""); setItemPriceReason(""); publishActivity();
      }
      if (canPublish()) onChanged();
    }
  };

  const remove = async (itemId: number) => {
    if (!plan.items.some((item) => item.id === itemId) || !startWrite()) return;
    let saved = false;
    try {
      const response = await fetch(`/api/plans/${plan.id}/items?itemId=${itemId}`, { method: "DELETE" });
      if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === "object") saved = true;
      else if (!response.ok && definitiveRejection(response.status)) { if (canPublish()) onError(payload?.message ?? "رُفض حذف البند."); }
      else recordUncertain();
    } catch { recordUncertain(); }
    finally { finishWrite(); }
    if (saved) { ++draftVersion.current; if (canPublish()) onChanged(); }
  };

  return (
    <div onChangeCapture={markDirty} className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-slate-500">
          بنود الخطة {plan.consentAt ? "— موافَقٌ عليها فلا تُعدَّل" : locked ? "— للقراءة فقط" : "— تُوزَّع على الجلسات"}
        </p>
        <span className="text-[10px] font-bold text-slate-400">
          {visitGroups.length > 0 ? `${visitGroups.length} جلسات مخططة` : ""}
        </span>
      </div>

      {visitGroups.length === 0 ? (
        <p className="text-xs text-slate-400">لا بنود بعد.</p>
      ) : (
        <div className="mb-2 space-y-2">
          {visitGroups.map((group) => {
            const allDone = group.allDone;
            const hasDone = group.doneCount > 0;
            return (
              <div key={group.visitNumber}
                className={`rounded-xl border p-2.5 ${
                  allDone
                    ? "border-emerald-200 bg-emerald-50/40"
                    : hasDone
                      ? "border-amber-200 bg-amber-50/20"
                      : "border-slate-200 bg-white/60"
                }`}>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-lg text-[10px] font-black ${
                      allDone ? "bg-emerald-600 text-white" : "bg-navy-800 text-white"
                    }`}>
                      {allDone ? "✓" : group.visitNumber}
                    </span>
                    <span className="text-[11px] font-black text-navy-900">الجلسة المخططة {group.visitNumber}</span>
                    <span className="text-[10px] text-slate-500">
                      ({group.items.length} إجراء{canSeeFinancial && group.totalMinor !== null ? ` · ${formatMoney(group.totalMinor, base)}` : ""})
                    </span>
                  </div>
                  {group.allDone ? (
                    <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">مكتملة</span>
                  ) : null}
                </div>
                <ul className="space-y-1">
                  {group.items.map((item) => (
                    <li key={item.id} ref={item.id === focusItemId ? focusedRow : undefined} tabIndex={item.id === focusItemId ? -1 : undefined} data-focused-plan-item={item.id === focusItemId ? String(item.id) : undefined} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        {item.status === "done" ? <span className="text-emerald-600">✓</span> : null}
                        <span className={`truncate font-bold ${item.status === "done" ? "text-emerald-700" : ""}`}>
                          {item.serviceName}
                        </span>
                        {item.toothCode ? (
                          <span className="shrink-0 text-slate-500">
                            · سن {item.toothCode}{item.surfaces ? ` (${item.surfaces})` : ""}
                          </span>
                        ) : null}
                        {(item.sessionCount ?? 1) > 1 ? (
                          <span className="shrink-0 text-slate-400">· جلسة {item.sessionsCompleted ?? 0}/{item.sessionCount ?? 1}</span>
                        ) : null}
                        {item.billingStatus === "billed" ? (
                          <span className="shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[9px] font-bold text-sky-700">مفوتر</span>
                        ) : item.billingStatus === "included_in_package" ? (
                          <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold text-purple-700">ضمن الباقة</span>
                        ) : item.billingStatus === "waived" ? (
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">معفى</span>
                        ) : null}
                        {item.doctorName ? (
                          <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">{item.doctorName}</span>
                        ) : null}
                      </span>
                      {onReviewWork && plan.status === "active" && ["planned", "in_progress"].includes(item.status) ? <button type="button" data-testid={`plan-review-visit-item-${item.id}`} disabled={busy || readPending} onClick={() => { if (!inFlight.current && canPublish()) onReviewWork(item); }} className="min-h-10 text-xs font-bold text-teal-800 underline">راجع في الزيارة</button> : null}
                      {canSeeFinancial && item.totalMinor !== null ? <span className="shrink-0 font-bold">{formatMoney(item.totalMinor, base)}</span> : null}
                      {locked ? null : (
                        <button onClick={() => void remove(item.id)} disabled={busy || readPending}
                          aria-label={`احذف ${item.serviceName}`}
                          className="shrink-0 rounded-md px-1.5 text-slate-400 hover:text-red-600 disabled:opacity-40">
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {locked ? (
        plan.itemsProgress.count > 0 ? (
          <p className="text-[11px] font-bold text-slate-500">
            أُنجز {plan.itemsProgress.doneCount} من {plan.itemsProgress.count} بنود ·{" "}
            {canSeeFinancial && plan.financialVisible ? `${formatMoney(plan.itemsProgress.doneMinor, base)} من ${formatMoney(plan.itemsProgress.totalMinor, base)}` : ""}
          </p>
        ) : null
      ) : (
        <fieldset disabled={busy || readPending || uncertain.current} className="space-y-2 pt-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">اختر الخدمة (مصنفة حسب الاختصاص)</span>
              {base !== CLINIC_BASE_CURRENCY ? (
                <p className="mb-1 text-[10px] font-bold text-amber-700">
                  خطة بعملة اتفاق ({CURRENCY_LABEL[base]}) — سعر الدليل يمنيّ ولا يُنسخ: اكتب سعر البند بعملة الخطة.
                </p>
              ) : null}
              {canViewCatalogPrices ? <ServiceSelect
                services={services.filter((item): item is Service => typeof item.priceMinor === "number")}
                value={serviceId}
                onChange={(id) => { if (inFlight.current || uncertain.current || !mounted.current) return; markDirty(); setServiceId(id || null); }}
                /* (TD-05 owner review) أسعار الدليل أساسيةٌ دائمًا — تُعرض
                   بعملتها الأصلية لا بعملة الخطة، فلا يبدو سعرٌ يمنيّ «سعرًا
                   دولاريًّا». */
                base={CLINIC_BASE_CURRENCY}
                placeholder="— اختر الخدمة لإضافتها للخطة —"
                ariaLabel="خدمة الخطة"
              /> : <select aria-label="خدمة الخطة" value={serviceId ?? ""}
                onChange={(event) => setServiceId(Number(event.target.value) || null)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs">
                <option value="">— اختر الخدمة لإضافتها للخطة —</option>
                {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>}
            </div>
            <label className="w-16">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الجلسة #</span>
              <input value={targetVisitNumber} onChange={(event) => setTargetVisitNumber(event.target.value)}
                aria-label="رقم الجلسة المخططة" inputMode="numeric" dir="ltr" placeholder="1" min="1"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <ToothField value={tooth} onChange={(value) => { if (inFlight.current || uncertain.current || !mounted.current) return; markDirty(); setTooth(value); }} ariaLabel="سن البند" className="w-20"
              label={<span className="mb-1 block text-[10px] font-bold text-slate-500">السن</span>} />
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الأسطح</span>
              <input value={surfaces} onChange={(event) => setSurfaces(event.target.value)}
                aria-label="أسطح البند" dir="ltr" placeholder="MO"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            <label className="w-20">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">عدد الجلسات</span>
              <input value={sessionCount} onChange={(event) => setSessionCount(event.target.value)}
                aria-label="عدد جلسات البند" inputMode="numeric" dir="ltr" placeholder="1" min="1"
                className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-semibold text-center" />
            </label>
            {base !== CLINIC_BASE_CURRENCY ? (
              <label className="w-28">
                <span className="mb-1 block text-[10px] font-bold text-slate-500">
                  السعر ({CURRENCY_SHORT[base]})
                </span>
                <input value={itemPrice} onChange={(event) => setItemPrice(event.target.value)}
                  aria-label={`سعر البند بعملة الخطة ${CURRENCY_LABEL[base]}`}
                  data-field="plan-item-price"
                  inputMode="decimal" dir="ltr" placeholder="0"
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs font-bold text-center" />
              </label>
            ) : null}
            {base !== CLINIC_BASE_CURRENCY && itemPrice.trim() ? (
              <label className="min-w-[10rem] flex-1">
                <span className="mb-1 block text-[10px] font-bold text-slate-500">سبب السعر (إن خالف الدليل)</span>
                <input value={itemPriceReason} onChange={(event) => setItemPriceReason(event.target.value)} maxLength={300}
                  aria-label="سبب سعر البند" placeholder="مثل: خصم متفق"
                  className="w-full rounded-xl border border-slate-200 px-2 py-2 text-xs" />
              </label>
            ) : null}
            <button onClick={() => void add()} disabled={busy || readPending || uncertain.current || !serviceId}
              data-action="plan-add-item"
              className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-extrabold text-white transition-opacity hover:opacity-90 disabled:opacity-40">
              + أضف للخطة
            </button>
          </div>
          {/* تنظيم الجلسة: قاعدة الفوترة والطبيب — السطر الثاني من النموذج. */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[12rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">قاعدة الفوترة</span>
              <select value={billingRule} onChange={(event) => setBillingRule(event.target.value as BillingRule)}
                aria-label="قاعدة فوترة البند"
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs font-semibold">
                {BILLING_RULES.map((rule) => (
                  <option key={rule} value={rule}>{BILLING_RULE_LABEL[rule]}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الطبيب المسؤول عن البند</span>
              <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
                aria-label="طبيب البند"
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs font-semibold">
                <option value="">— طبيب الخطة الافتراضي —</option>
                {doctors.map((doc) => (
                  <option key={doc.id} value={doc.id}>{doc.name}</option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
      )}
    </div>
  );
}

/**
 * تسجيل الموافقة — والتقسيط معها إن أراد المريض.
 *
 * يُسألان في النَّفَس نفسه على الكرسي: «موافق؟» ثم «أقدر أقسّطها؟». وفصلُهما إلى
 * خطوتين يجعل نصف الخطط تُوافَق ولا تُجدوَل.
 */
function ConsentForm({ plan, onDone, onError, onCancel, canSubmit, canPublishMutation, onUncertain, onAccessDenied, readPending = false, onBusyChange }: {
  plan: FinancialPatientPlan; onDone: () => void; onError: (message: string | null) => void;
  onCancel?: () => void; canSubmit?: () => boolean; canPublishMutation?: () => boolean; readPending?: boolean;
  onUncertain?: () => void; onAccessDenied?: (status: number) => void;
  onBusyChange?: (pending: boolean) => boolean | void;
}) {
  // (TD-05) الموافقة على مبلغ الخطة بعملة اتفاقها.
  const base: Currency = plan.baseCurrency;
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [note, setNote] = useState("توقيع ورقي محفوظ بالملف");
  const [split, setSplit] = useState(false);
  const [count, setCount] = useState("6");
  const [everyDays, setEveryDays] = useState("30");
  const [firstDueDate, setFirstDueDate] = useState(today);
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);
  const uncertain = useRef(false);
  const mounted = useRef(false);
  // Retained handlers lose authority at the unmount commit, before passive cleanup.
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canPublish = () => mounted.current && (canPublishMutation ? canPublishMutation() : canSubmit?.() !== false);
  const recordUncertain = () => {
    if (!uncertain.current) { uncertain.current = true; onUncertain?.(); }
    if (canPublish()) onError("نتيجة حفظ الموافقة وجدولتها غير مؤكدة؛ قد تكون العملية اكتملت. راجع السجل قبل أي إدخال جديد.");
  };
  const submit = async () => {
    if (!mounted.current || uncertain.current || inFlight.current || busy || readPending || canSubmit?.() === false) return;
    if (onBusyChange?.(true) === false) return;
    inFlight.current = true; setBusy(true);
    onError(null);
    let saved = false;
    try {
      const response = await fetch(`/api/plans/${plan.id}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          ...(split ? { count: Number(count), everyDays: Number(everyDays), firstDueDate } : {}),
        }),
      });
      if ([401, 403, 404].includes(response.status)) onAccessDenied?.(response.status);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && typeof payload === "object") saved = true;
      else if ([401, 403, 404].includes(response.status)) { if (canPublish()) onError(payload?.message ?? "رُفض الوصول إلى الموافقة."); }
      else recordUncertain();
    } catch { recordUncertain(); }
    finally {
      inFlight.current = false; onBusyChange?.(false);
      if (mounted.current) setBusy(false);
    }
    if (saved && canPublish()) onDone();
  };

  return (
    <div className="mt-2 rounded-xl border border-emerald-300 bg-emerald-50 p-3">
      <fieldset disabled={busy || readPending || uncertain.current}>
      <p className="mb-2 text-xs font-bold text-emerald-900">
        {plan.items.length === 0
          ? `موافقة المريض على اتفاق بمبلغ ${formatMoney(plan.totalMinor, base)} — اتفاقٌ ماليّ بلا بنود علاجية محدّدة؛ بعدها لا يتغيّر المبلغ ولا تُضاف إليه بنود (يُوثَّق المستجدّ باتفاق جديد).`
          : `موافقة المريض على ${formatMoney(plan.totalMinor, base)} — وبعدها تُقفل البنود.`}
      </p>
      <input value={note} onChange={(event) => setNote(event.target.value)}
        aria-label="كيف وُثّقت الموافقة"
        className="mb-2 w-full rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 text-xs" />

      {plan.installments.length === 0 ? (
        <label className="mb-2 flex items-center gap-2 text-xs font-bold text-emerald-900">
          <input type="checkbox" checked={split} onChange={(event) => setSplit(event.target.checked)} />
          قسّطها
        </label>
      ) : (
        <p className="mb-2 text-[11px] font-bold text-slate-500">لهذا الاتفاق جدول أقساط قائم — لا يُعاد تقسيطه.</p>
      )}

      {split && plan.installments.length === 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <input value={count} onChange={(event) => setCount(event.target.value)}
            aria-label="عدد الأقساط" inputMode="numeric" dir="ltr"
            className="w-20 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
          <input value={everyDays} onChange={(event) => setEveryDays(event.target.value)}
            aria-label="كل كم يوم" inputMode="numeric" dir="ltr"
            className="w-20 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
          <input type="date" value={firstDueDate} onChange={(event) => setFirstDueDate(event.target.value)}
            aria-label="أول قسط"
            className="flex-1 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs" />
        </div>
      ) : null}

      <button onClick={() => void submit()} disabled={busy || readPending || plan.totalMinor <= 0}
        className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-extrabold text-white disabled:opacity-40">
        سجّل الموافقة
      </button>
      </fieldset>
      <button type="button" data-testid="plan-consent-cancel" disabled={busy} onClick={() => { if (mounted.current && !inFlight.current) onCancel?.(); }} className="mt-2 w-full rounded-lg border border-emerald-300 py-2 text-xs font-bold">إلغاء</button>
    </div>
  );
}
