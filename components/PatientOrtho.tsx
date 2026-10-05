"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LegacyOnboardingChecklist } from "./LegacyOnboardingChecklist";
import { OrthoPackageLink } from "./OrthoPackageLink";
import {
  APPLIANCE_LABEL, ARCHES_LABEL, CASE_STATUS_LABEL, ELASTIC_LABEL, PHASE_HINT,
  PHASE_LABEL, PHASE_ORDER, RETAINER_LABEL, SLOT_LABEL,
  nextAdjustmentDate, usesArchwires, wiresFor,
  type Appliance, type Arches, type CaseStatus, type ElasticClass,
  type OrthoPhase, type RetainerType, type SlotSize,
} from "@/lib/ortho";
import {
  PHOTO_STAGE_LABEL, PHOTO_VIEW_LABEL, buildComparison, fullPhotoSetCheck,
  suggestPhotoStage, type PhotoStage, type PhotoView, type StagePhoto,
} from "@/lib/ortho-photos";
import {
  friendlyDateLong, friendlyTime, orthoSessionBookedText, toWhatsAppNumber,
} from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { useClinicName, useSetting } from "./SettingsProvider";
import { PatientCeph } from "./PatientCeph";
import { PatientDiagnosis } from "./PatientDiagnosis";
import { WebCephRecordsGrid } from "./WebCephRecordsGrid";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import {
  LEGACY_FINANCIAL_HINT, LEGACY_FINANCIAL_LABEL, LEGACY_FINANCIAL_MODES, monthsBefore,
  type LegacyFinancialMode,
} from "@/lib/ortho-baseline";
import { useSession, type SessionInfo } from "./SessionProvider";

/**
 * كابينة تقويم الأسنان التخصصية (Orthodontic Specialty Cockpit).
 *
 * تجسد معمارية برمجيات التقويم العالمية الرائدة (Dolphin Imaging, WebCeph, OrthoTrac)
 * القائمة على أربعة أركان سريرية متكاملة للحالة:
 *
 * ١) الركن التشخيصي (Diagnostic Records & Imaging):
 *    - التحليل السيفالومتري ومخطط ويب سيف (T1 ما قبل العلاج، T2 أثناء التقدم، T3 بعد العلاج، T4 المتابعة)
 *    - التوثيق الصوري ومقارنة التطور (5 صور داخل الفم + 3 صور للوجه والبروفايل)
 *    - التحليل السريري للفكين والأسنان وتصنيف مالوكلوجن
 *
 * ٢) خطة العلاج والميكانيكا الحيوية (Prescription & Biomechanics):
 *    - نوع الجهاز (معدني، خزفي، شفاف، وظيفي)، حجم الشق (0.018 / 0.022)، فلسفة البراكيت
 *    - خطة القلع، الزريعات TADs، التوسيع، وملاحظات الإرساء
 *
 * ٣) مسار الجلسات وتتابع الأسلاك (Archwire Progression & Timeline):
 *    - شريط الأسلاك الفوري على الكرسي (Upper & Lower Wires)
 *    - محدد المراحل السريرية (Aligning -> Working -> Finishing -> Retention)
 *    - تسجيل الشدّة السريعة، اقتراح السلك، صنف المطاطات، والتقاط الصور الحية
 *    - إغلاق الحلقة: حجز الجلسة القادمة التلقائي والتذكير
 *
 * ٤) التثبيت والاستبقاء (Retention & Stability):
 *    - اختيار المثبت (Hawley, Essix, Bonded) وتاريخ التسليم ومواعيد الفحص الدوري
 *    - الإغلاق الآمن للحالة لمنع ارتداد الأسنان
 */

interface SessionPhoto {
  id: number;
  title: string;
  isImage: boolean;
  photoStage: string | null;
  photoView: string | null;
  takenOn: string | null;
}

interface Adjustment {
  id: number; visitId: number | null; visitSigned: boolean; doneOn: string; phase: OrthoPhase | null;
  upperWire: string | null; lowerWire: string | null; elastics: ElasticClass;
  elasticNote: string | null; done: string | null; nextWeeks: number;
  note: string | null; recordedBy: string;
  photos: SessionPhoto[];
}

interface OrthoCase {
  id: number; appliance: Appliance; arches: Arches; slot: SlotSize;
  bracketSystem: string | null; status: CaseStatus; phase: OrthoPhase;
  startDate: string; plannedMonths: number;
  upperWire: string | null; lowerWire: string | null; planId: number | null;
  retainer: RetainerType | null; retainerOn: string | null; note: string | null;
  closedAt: string | null; closedBy: string | null; closedNote: string | null;
  baselineKind: "legacy" | null; baselineRecordedAt: string | null; elastics: string | null;
  responsibleDoctorName: string | null; legacyFinancialMode: LegacyFinancialMode | null;
  remainingObjectives: string | null;
  /** Absent on older payloads; explicit false means withheld, not an empty album. */
  photosVisible?: boolean;
  adjustments: Adjustment[];
  progress: {
    monthsElapsed: number; monthsPlanned: number; monthsRemaining: number;
    percent: number; overdue: boolean; adjustments: number;
    lastAdjustment: string | null; daysSinceLast: number | null;
  };
}

type OrthoPillar = "wires" | "diagnostics" | "prescription" | "retention";

const PILLAR_TABS: { key: OrthoPillar; label: string; icon: string }[] = [
  { key: "wires", label: "مسار الأسلاك والشدّات", icon: "⚡" },
  { key: "diagnostics", label: "السجلات والسيفالومتري (WebCeph)", icon: "📐" },
  { key: "prescription", label: "خطة العلاج والميكانيكا", icon: "⚙️" },
  { key: "retention", label: "التثبيت والاستبقاء", icon: "🛡️" },
];

function monthsText(months: number): string {
  if (months < 1) return "أقل من شهر";
  const whole = Math.round(months);
  if (whole === 1) return "شهر";
  if (whole === 2) return "شهرين";
  if (whole <= 10) return `${whole} أشهر`;
  return `${whole} شهرًا`;
}

function daysText(days: number): string {
  if (days === 1) return "قبل يوم";
  if (days === 2) return "قبل يومين";
  if (days <= 10) return `قبل ${days} أيام`;
  return `قبل ${days} يومًا`;
}

interface QueuedPhoto {
  file: File;
  preview: string;
  view: PhotoView | "";
}

interface SavedAdjustment {
  adjustmentId: number;
  caseId: number;
  doneOn: string;
  nextWeeks: number;
  photosUploaded: number;
  /** (VISIT-FLOW-1) زيارة اليوم التي رُبطت بها الشدّة في الخادم، أو null. */
  visitId: number | null;
}

export const ORTHO_PARENT_READ_TIMEOUT_MS = 15_000;
type OrthoReadState = "loading" | "ready" | "error" | "denied";
type Draft = { values: Map<string, unknown>; urls: Set<string>; active: boolean; busy: boolean; uncertain: boolean };
type Mutation = { draft: Draft; sequence: number; denial: number; active: boolean };
type OrthoOwner = {
  active: boolean; denied: boolean; clinical: boolean; contact: boolean; standalone: boolean;
  readSequence: number; mutationSequence: number; denialSequence: number;
  controller: AbortController | null; timer: ReturnType<typeof setTimeout> | null;
  cases: OrthoCase[]; drafts: Map<string, Draft>; mutations: Set<Mutation>;
  deny: () => void;
};
const OrthoOwnerContext = createContext<OrthoOwner | null>(null);
function makeOwner(standalone = false): OrthoOwner {
  return { active: false, denied: false, clinical: standalone, contact: standalone, standalone,
    readSequence: 0, mutationSequence: 0, denialSequence: 0, controller: null, timer: null,
    cases: [], drafts: new Map(), mutations: new Set(), deny: () => {} };
}
function draftFor(owner: OrthoOwner, key: string): Draft {
  let draft = owner.drafts.get(key);
  if (!draft) { draft = { values: new Map(), urls: new Set(), active: true, busy: false, uncertain: false }; owner.drafts.set(key, draft); }
  return draft;
}
function disposeDraft(owner: OrthoOwner, key: string) {
  const draft = owner.drafts.get(key);
  if (!draft) return;
  draft.active = false;
  for (const url of draft.urls) URL.revokeObjectURL(url);
  draft.urls.clear(); draft.values.clear(); owner.drafts.delete(key);
}
function retireOwner(owner: OrthoOwner) {
  owner.active = false; owner.clinical = false; owner.contact = false;
  owner.readSequence++; owner.denialSequence++; owner.controller?.abort(); owner.cases = [];
  if (owner.timer !== null) clearTimeout(owner.timer);
  for (const operation of owner.mutations) operation.active = false;
  for (const key of owner.drafts.keys()) disposeDraft(owner, key);
}
function sessionScope(session: SessionInfo | null) {
  return JSON.stringify(session ? [session.username, session.role, session.permissions ?? null] : null);
}
function currentMutation(owner: OrthoOwner, operation: Mutation | null): operation is Mutation {
  return !!operation && owner.active && !owner.denied && operation.active && operation.draft.active
    && operation.denial === owner.denialSequence;
}
function beginMutation(owner: OrthoOwner, draft: Draft, allowed: boolean): Mutation | null {
  if (!owner.active || owner.denied || !owner.clinical || !draft.active || draft.busy || draft.uncertain || !allowed) return null;
  draft.busy = true;
  const operation = { draft, sequence: ++owner.mutationSequence, denial: owner.denialSequence, active: true };
  owner.mutations.add(operation); return operation;
}
function endMutation(owner: OrthoOwner, operation: Mutation) {
  operation.active = false; operation.draft.busy = false; owner.mutations.delete(operation);
}
function mayUpload(session: SessionInfo | null) {
  return !!session?.username?.trim() && (session.role === "admin" || session.role === "reception"
    || (session.role === "doctor" && session.permissions?.canUploadXrays === true));
}

/** A draft belongs to the workspace, not to a temporary rendered view. */
function useOrthoDraft(key: string, patientId?: number, caseId?: number) {
  const parent = useContext(OrthoOwnerContext);
  const session = useSession();
  const authority = sessionScope(session);
  const fallback = useMemo(() => makeOwner(true), [authority, patientId, caseId]);
  const owner = parent ?? fallback;
  const draft = draftFor(owner, key);
  const lease = useMemo(() => ({ active: false }), [owner, draft]);
  const [, render] = useState(0);
  useLayoutEffect(() => {
    if (!parent) { owner.active = true; owner.clinical = true; owner.contact = true; draft.active = true; owner.drafts.set(key, draft); }
    lease.active = true;
    return () => { lease.active = false; if (!parent) retireOwner(owner); };
  }, [owner, parent, lease, draft, key]);
  const redraw = () => { if (lease.active && owner.active) render((value) => value + 1); };
  const editable = () => lease.active && owner.active && owner.clinical && !owner.denied && draft.active && !draft.busy && !draft.uncertain;
  const field = <T,>(name: string, initial: T | (() => T)): [T, (value: T | ((before: T) => T)) => void] => {
    if (!draft.values.has(name)) draft.values.set(name, typeof initial === "function" ? (initial as () => T)() : initial);
    return [draft.values.get(name) as T, (update) => {
      if (!editable()) return;
      draft.values.set(name, typeof update === "function" ? (update as (before: T) => T)(draft.values.get(name) as T) : update);
      redraw();
    }];
  };
  const caseGranted = () => owner.active && !owner.denied && owner.clinical
    && (caseId === undefined || owner.standalone || owner.cases.some((row) => row.id === caseId));
  return { owner, draft, session, editable, field, caseGranted,
    commit: (name: string, value: unknown) => { if (!owner.active || owner.denied || !draft.active) return; draft.values.set(name, value); redraw(); },
    begin: (allowed = true) => {
      if (!lease.active) return null;
      const operation = beginMutation(owner, draft, allowed && caseGranted());
      redraw(); return operation;
    },
    current: (operation: Mutation) => currentMutation(owner, operation),
    checkHeaders: (response: Response, operation: Mutation) => {
      if (!currentMutation(owner, operation)) return false;
      if (response.status === 401 || response.status === 403) { owner.deny(); return false; }
      return true;
    },
    uncertain: () => { draft.uncertain = true; redraw(); },
    finish: (operation: Mutation) => { endMutation(owner, operation); redraw(); },
    release: (url: string) => { if (draft.urls.delete(url)) URL.revokeObjectURL(url); },
  };
}
function UncertainWrite({ draft }: { draft: Draft }) {
  return draft.uncertain ? <p role="alert" data-testid="ortho-write-uncertain" className="mt-2 text-xs font-bold text-amber-900">
    تعذّر تأكيد نتيجة الطلب السابق. قد يكون نُفّذ؛ راجع السجل بعد إعادة التحميل قبل فتح نموذج جديد. إعادة التحميل لا تعيد إرسال الطلب.
  </p> : null;
}

function readCases(payload: unknown, patientId: number): OrthoCase[] {
  const list = payload && typeof payload === "object" ? (payload as { cases?: unknown }).cases : null;
  if (!Array.isArray(list)) throw new Error("تعذّر التحقق من حالات التقويم.");
  const ids = new Set<number>();
  for (const row of list) {
    if (!row || typeof row !== "object" || row.patientId !== patientId || !Number.isSafeInteger(row.id) || row.id <= 0
      || ids.has(row.id) || !Array.isArray(row.adjustments) || !row.progress
      || row.adjustments.some((entry: unknown) => {
        if (!entry || typeof entry !== "object") return true;
        const one = entry as Partial<Adjustment>;
        return !Number.isSafeInteger(one.id) || Number(one.id) <= 0 || typeof one.doneOn !== "string"
          || typeof one.visitSigned !== "boolean" || !(one.visitId === null || (Number.isSafeInteger(one.visitId) && Number(one.visitId) > 0))
          || !Array.isArray(one.photos) || !Number.isFinite(one.nextWeeks);
      })
      || !Object.hasOwn(CASE_STATUS_LABEL, row.status) || !Object.hasOwn(PHASE_LABEL, row.phase)
      || !Object.hasOwn(APPLIANCE_LABEL, row.appliance) || !Object.hasOwn(ARCHES_LABEL, row.arches)
      || !Object.hasOwn(SLOT_LABEL, row.slot)) throw new Error("تعذّر التحقق من حالات التقويم.");
    ids.add(row.id);
  }
  return list as OrthoCase[];
}

export function PatientOrtho({ patientId }: { patientId: number }) {
  const session = useSession();
  const authority = sessionScope(session);
  const owner = useMemo(() => makeOwner(), [patientId, authority]);
  useLayoutEffect(() => { owner.active = true; return () => retireOwner(owner); }, [owner]);
  return <OrthoOwnerContext.Provider value={owner}>
    <PatientOrthoWorkspace key={`${patientId}:${authority}`} patientId={patientId} />
  </OrthoOwnerContext.Provider>;
}

function PatientOrthoWorkspace({ patientId }: { patientId: number }) {
  const owner = useContext(OrthoOwnerContext)!;
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [cases, setCases] = useState<OrthoCase[]>([]);
  const [patient, setPatient] = useState<{ name: string; phone: string | null } | null>(null);
  const [readState, setReadState] = useState<OrthoReadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [recordingLegacy, setRecordingLegacy] = useState(false);
  const session = useSession();
  const canRecordBaseline = session?.role === "doctor" || session?.role === "admin";
  const [adjusting, setAdjusting] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedAdjustment | null>(null);
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const [, redrawMutation] = useState(0);

  // تبويب الركن النشط لكل حالة (افتراضيًا: الأسلاك والشدّات)
  const [activePillars, setActivePillars] = useState<Record<number, OrthoPillar>>({});

  const renderRead = owner.readSequence;
  const currentView = () => owner.active && !owner.denied && owner.clinical && owner.readSequence === renderRead;
  const mayDiscard = (key: string) => { const draft = owner.drafts.get(key); return !draft?.busy && !draft?.uncertain; };
  const setPillarForCase = (caseId: number, pillar: OrthoPillar) => {
    if (!currentView()) return;
    setActivePillars((prev) => ({ ...prev, [caseId]: pillar }));
  };

  const deny = useCallback(() => {
    if (!owner.active) return;
    owner.denied = true; owner.clinical = false; owner.contact = false;
    owner.denialSequence++; owner.controller?.abort(); owner.cases = [];
    if (owner.timer !== null) { clearTimeout(owner.timer); owner.timer = null; }
    for (const operation of owner.mutations) {
      operation.active = false; operation.draft.uncertain = true;
    }
    setCases([]); setPatient(null); setReadState("denied");
    setError("غير مصرّح لك بعرض كابينة التقويم لهذا المريض.");
  }, [owner]);
  useLayoutEffect(() => { owner.deny = deny; }, [owner, deny]);
  const load = useCallback(() => {
    if (!owner.active) return;
    owner.controller?.abort();
    if (owner.timer !== null) clearTimeout(owner.timer);
    const controller = new AbortController(); owner.controller = controller;
    const sequence = ++owner.readSequence;
    const current = () => owner.active && owner.readSequence === sequence && !controller.signal.aborted;
    owner.denied = false; owner.clinical = false; owner.contact = false; owner.cases = [];
    setReadState("loading"); setPatient(null); setError(null);
    if (!session?.username?.trim() || !["admin", "doctor", "reception", "assistant"].includes(session.role)) {
      deny(); return;
    }
    let finished = 0;
    const finish = () => { if (++finished === 2 && owner.timer !== null && owner.readSequence === sequence) {
      clearTimeout(owner.timer); owner.timer = null;
    } };
    owner.timer = setTimeout(() => {
      if (!current()) return;
      controller.abort();
      if (!owner.clinical) { setCases([]); setReadState("error"); }
      if (!owner.contact) setPatient(null);
      setError("تعذّر إكمال قراءة كابينة التقويم. أعد التحميل.");
      owner.timer = null;
    }, ORTHO_PARENT_READ_TIMEOUT_MS);
    const read = async (kind: "clinical" | "contact") => {
      try {
        const response = await fetch(kind === "clinical" ? `/api/ortho?patientId=${patientId}` : `/api/patients/${patientId}`,
          { cache: "no-store", signal: controller.signal });
        if (!current()) return;
        // Both endpoints guard this patient/session; denial is authoritative at headers.
        if (response.status === 401 || response.status === 403) { deny(); return; }
        if (!response.ok) throw new Error("Read unavailable");
        const payload: unknown = await response.json();
        if (!current()) return;
        if (kind === "clinical") {
          const verified = readCases(payload, patientId);
          owner.cases = verified; owner.clinical = true; setCases(verified); setReadState("ready");
        } else {
          const patient = payload && typeof payload === "object" ? (payload as { patient?: unknown }).patient : null;
          if (!patient || typeof patient !== "object") throw new Error("Invalid patient");
          const row = patient as { id?: unknown; fullName?: unknown; phone?: unknown };
          if (row.id !== patientId || typeof row.fullName !== "string" || (row.phone !== null && typeof row.phone !== "string")) throw new Error("Invalid patient");
          owner.contact = true; setPatient({ name: row.fullName, phone: row.phone });
        }
      } catch {
        if (!current()) return;
        if (kind === "clinical") { owner.clinical = false; owner.cases = []; setCases([]); setReadState("error"); }
        else { owner.contact = false; setPatient(null); }
        setError(kind === "clinical" ? "تعذّر تحميل حالات التقويم. أعد التحميل." : "تعذّر التحقق من بيانات المريض؛ الحجز والتذكير متوقفان حتى نجاح القراءة.");
      } finally { finish(); }
    };
    // Independent continuations: no stalled peer or JSON body can postpone denial.
    void read("clinical"); void read("contact");
  }, [owner, patientId, session?.username, session?.role, deny]);

  useEffect(() => { load(); }, [load]);

  const refreshAfterConfirmedChange = () => {
    if (!owner.active || owner.denied) return;
    setOnboardingRevision((value) => value + 1);
    load();
  };
  const currentCase = (id: number) => currentView() && owner.cases.some((row) => row.id === id);
  const safeError = (message: string | null) => { if (owner.active && !owner.denied) setError(message); };

  const open = cases.find((row) => row.status === "active" || row.status === "retention");
  const unsignedTodayVisitId = cases.flatMap((row) => row.adjustments)
    .find((entry) => entry.doneOn === today && entry.visitId !== null && !entry.visitSigned)?.visitId ?? null;
  const savedCaseAvailable = saved !== null && cases.some((row) => row.id === saved.caseId);
  const signVisitId = (savedCaseAvailable ? saved?.visitId : null) ?? unsignedTodayVisitId;

  const patch = async (id: number, body: Record<string, unknown>) => {
    const draft = draftFor(owner, "case-patch");
    const operation = beginMutation(owner, draft, currentCase(id));
    if (!operation) return false;
    redrawMutation((value) => value + 1);
    try {
      const response = await fetch(`/api/ortho/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!currentMutation(owner, operation)) return false;
      if (response.status === 401 || response.status === 403) { deny(); return false; }
      const payload = await response.json().catch(() => null);
      if (!currentMutation(owner, operation)) return false;
      if (!response.ok) { if (response.status >= 500) draft.uncertain = true; safeError(payload?.message ?? "تعذّر التنفيذ."); return false; }
      safeError(null); refreshAfterConfirmedChange(); return true;
    } catch {
      if (currentMutation(owner, operation)) { draft.uncertain = true; safeError("تعذّر تأكيد نتيجة التعديل. راجع الحالة بعد إعادة التحميل قبل تكراره."); }
      return false;
    } finally { endMutation(owner, operation); if (owner.active) redrawMutation((value) => value + 1); }
  };

  if (readState !== "ready" || !owner.clinical) {
    return <div data-testid="patient-ortho-workspace" data-read-state={readState}
      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <p role={error ? "alert" : "status"}>{error ?? "جارٍ التحقق من كابينة التقويم…"}</p>
      {owner.drafts.size > 0 ? <p className="text-xs text-slate-600">احتُفظ بالنماذج لهذه الجلسة دون عرضها؛ الحفظ متوقف حتى نجاح إعادة التحميل.</p> : null}
      {[...owner.drafts.values()].some((draft) => draft.uncertain) ? <UncertainWrite draft={[...owner.drafts.values()].find((draft) => draft.uncertain)!} /> : null}
      <button type="button" aria-label="إعادة تحميل كابينة التقويم" onClick={load}
        className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold">إعادة تحميل كابينة التقويم</button>
    </div>;
  }

  return (
    <div className="space-y-4" data-testid="patient-ortho-workspace" data-read-state="ready">
      <button type="button" aria-label="تحديث كابينة التقويم" onClick={load}
        className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">تحديث كابينة التقويم</button>
      {owner.drafts.get("case-patch")?.uncertain ? <UncertainWrite draft={owner.drafts.get("case-patch")!} /> : null}
      {(opening || recordingLegacy) && open ? <p role="status" className="text-xs text-slate-600">احتُفظ بالنموذج؛ توجد حالة مفتوحة في القراءة الحالية، لذلك لا يُعاد إرساله.</p> : null}
      {adjusting !== null && !cases.some((row) => row.id === adjusting && (row.status === "active" || row.status === "retention")) ? <p role="status" className="text-xs text-slate-600">احتُفظ بمسودة الشدّة؛ الحالة المرتبطة بها غير متاحة للتعديل في القراءة الحالية.</p> : null}
      {adjusting !== null && !cases.some((row) => row.id === adjusting) && owner.drafts.get(`adjust:${adjusting}`)?.uncertain ? (
        <UncertainWrite draft={owner.drafts.get(`adjust:${adjusting}`)!} />
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* بطاقة الجلسة القادمة المقترحة — إغلاق الحلقة السريرية فورياً */}
      {signVisitId ? (
        <SignTodayVisitCard key={signVisitId} visitId={signVisitId} onError={safeError} />
      ) : null}
      {saved && !savedCaseAvailable ? (
        <p role="status" className="text-xs text-slate-600">احتُفظ بمسودة الموعد دون عرضها؛ الحالة المرتبطة بها غير متاحة في القراءة الحالية.</p>
      ) : null}
      {saved && savedCaseAvailable ? (
        <NextAppointmentCard
          patientId={patientId}
          patientName={patient?.name ?? ""}
          patientPhone={patient?.phone ?? null}
          draftKey={`next:${saved.adjustmentId}`} contactReady={owner.contact}
          caseId={saved.caseId}
          doneOn={saved.doneOn}
          nextWeeks={saved.nextWeeks}
          photosUploaded={saved.photosUploaded}
          onDismiss={() => { if (!currentView() || !mayDiscard(`next:${saved.adjustmentId}`)) return; disposeDraft(owner, `next:${saved.adjustmentId}`); setSaved(null); }}
          onError={safeError}
        />
      ) : null}

      {/* زر فتح حالة تقويم جديدة إن لم تكن هناك حالة قائمة */}
      {!open ? (
        <div className="rounded-2xl border border-dashed border-navy-300 bg-navy-50/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-extrabold text-navy-900">
                فتح حالة تقويم تخصصية جديدة
              </p>
              <p className="text-xs text-slate-600">
                تسجيل خطة التقويم، الأقواس السنية، مقاس الشق، وفلسفة الحاصرات
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { if (!currentView() || !mayDiscard("new") || !mayDiscard("baseline")) return; if (opening) disposeDraft(owner, "new"); disposeDraft(owner, "baseline"); setOpening((value) => !value); setRecordingLegacy(false); }}
                className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white hover:bg-navy-900 transition-colors shadow-xs"
              >
                {opening ? "✕ إغلاق النموذج" : "+ فتح حالة تقويم جديدة"}
              </button>
              {canRecordBaseline ? (
                <button
                  onClick={() => { if (!currentView() || !mayDiscard("new") || !mayDiscard("baseline")) return; if (recordingLegacy) disposeDraft(owner, "baseline"); disposeDraft(owner, "new"); setRecordingLegacy((value) => !value); setOpening(false); }}
                  className="rounded-xl border border-navy-800 bg-white px-4 py-2 text-xs font-black text-navy-900 hover:bg-navy-50 transition-colors"
                >
                  {recordingLegacy ? "✕ إغلاق النموذج" : "تسجيل حالة سابقة (قبل النظام)"}
                </button>
              ) : null}
            </div>
          </div>
          {recordingLegacy ? (
            <div className="mt-3">
              <LegacyBaselineForm
                patientId={patientId}
                today={today}
                onSaved={() => { if (!owner.active || owner.denied) return; disposeDraft(owner, "baseline"); setRecordingLegacy(false); refreshAfterConfirmedChange(); }}
                onError={safeError}
              />
            </div>
          ) : null}
          {opening ? (
            <div className="mt-3">
              <NewCase
                patientId={patientId}
                today={today}
                onSaved={() => { if (!owner.active || owner.denied) return; disposeDraft(owner, "new"); setOpening(false); refreshAfterConfirmedChange(); }}
                onError={safeError}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* إذا لم تكن هناك حالات مسجلة للمريض: نوفر مساحة التشخيص والسيفالومتري التمهيدي */}
      {cases.length === 0 && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="mb-2">
              <h4 className="text-sm font-extrabold text-navy-900">
                📐 السجلات التشخيصية والسيفالومتري التمهيدي (T1 Pre-treatment)
              </h4>
              <p className="text-xs text-slate-500">
                يمكنك إجراء وتوثيق التتبع السيفالومتري لدراسة الحالة قبل تركيب الحاصرات وفتح ملف التقويم
              </p>
            </div>
            <PatientCeph patientId={patientId} embedded={true} />
          </div>
        </div>
      )}



      {/* قائمة حالات التقويم مع هيكلية الأركان الأربعة */}
      {cases.length > 0 && (
        <ul className="space-y-4">
          {cases.map((row) => {
            const live = row.status === "active" || row.status === "retention";
            const wires = wiresFor(row.slot);
            const currentPillar: OrthoPillar = activePillars[row.id] ?? "wires";

            return (
              <li
                key={row.id}
                className={`rounded-2xl border shadow-xs overflow-hidden transition-all ${
                  live ? "border-navy-200 bg-white" : "border-slate-200 bg-slate-50/70 opacity-80"
                }`}
              >
                {/* رأس الحالة التقويمية */}
                <div className="border-b border-slate-100 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-navy-800 text-xs font-bold text-white">
                        #{row.id}
                      </span>
                      <span className="text-base font-black text-navy-900">
                        {APPLIANCE_LABEL[row.appliance]} · {ARCHES_LABEL[row.arches]}
                      </span>
                      {row.bracketSystem && (
                        <span className="rounded-md bg-white border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700 font-mono" dir="ltr">
                          {row.bracketSystem} · {SLOT_LABEL[row.slot]}
                        </span>
                      )}
                      {row.baselineKind === "legacy" ? (
                        <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-black text-amber-900">
                          بدأ قبل النظام
                        </span>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-black border ${
                          live
                            ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                            : "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {CASE_STATUS_LABEL[row.status]}
                      </span>
                      <span className="rounded-full bg-navy-100 px-2.5 py-0.5 text-[11px] font-bold text-navy-900">
                        {PHASE_LABEL[row.phase]}
                      </span>
                    </div>
                  </div>

                  {row.baselineKind === "legacy" ? <LegacyBaselineSummary row={row} /> : null}
                  {row.baselineKind === "legacy" && (row.status === "active" || row.status === "retention")
                    ? <LegacyOnboardingChecklist patientId={patientId} caseId={row.id} planId={row.planId}
                        refreshRevision={onboardingRevision} /> : null}
                  {(row.status === "active" || row.status === "retention")
                    && (row.baselineKind !== "legacy" || row.legacyFinancialMode === "installments") ? (
                      <OrthoPackageLink caseId={row.id} patientId={patientId} planId={row.planId}
                        canLink={session?.role === "admin" || session?.role === "reception"
                          || (session?.role === "doctor" && session.permissions?.canEditPlans !== false)}
                        onChanged={() => { if (currentView()) refreshAfterConfirmedChange(); }} />
                    ) : null}

                  {/* شريط الإحصائيات السريعة ومعدل التقدم */}
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">{monthsText(row.progress.monthsElapsed)}</p>
                      <p className="text-[10px] text-slate-500">انقضى من العلاج</p>
                    </div>
                    <div className={`rounded-xl p-2 border ${
                      row.progress.overdue
                        ? "bg-amber-50 border-amber-300 text-amber-900"
                        : "bg-white border-slate-200/80 text-slate-700"
                    }`}>
                      <p className="font-extrabold">
                        {row.progress.overdue ? "تجاوزت المدة" : monthsText(row.progress.monthsRemaining)}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.progress.overdue ? `المخطط ${row.plannedMonths} شهرًا` : "المتبقي المتوقع"}
                      </p>
                    </div>
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">{row.progress.adjustments}</p>
                      <p className="text-[10px] text-slate-500">جلسات وشدّات منفذة</p>
                    </div>
                    <div className="rounded-xl bg-white p-2 border border-slate-200/80">
                      <p className="font-extrabold text-navy-900">
                        {row.progress.lastAdjustment
                          ? friendlyDateLong(row.progress.lastAdjustment)
                          : "—"}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.progress.daysSinceLast !== null
                          ? daysText(row.progress.daysSinceLast)
                          : "لا شدّات بعد"}
                      </p>
                    </div>
                  </div>

                  {/* شريط التقدم الزمني */}
                  <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={`h-full transition-all ${
                        row.progress.overdue ? "bg-amber-500" : "bg-navy-800"
                      }`}
                      style={{ width: `${Math.min(100, row.progress.percent)}%` }}
                    />
                  </div>
                </div>

                {/* أشرطة الأركان الأربعة التخصصية (Pillar Navigation) */}
                <div className="flex border-b border-slate-200 bg-white">
                  {PILLAR_TABS.map((tab) => {
                    const isSelected = currentPillar === tab.key;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => { if (currentCase(row.id)) setPillarForCase(row.id, tab.key); }}
                        className={`flex-1 py-2.5 text-xs font-black transition-all border-b-2 flex items-center justify-center gap-1.5 ${
                          isSelected
                            ? "border-navy-800 text-navy-900 bg-navy-50/40"
                            : "border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-50"
                        }`}
                      >
                        <span>{tab.icon}</span>
                        <span className="hidden sm:inline">{tab.label}</span>
                        <span className="sm:hidden">{tab.label.split(" ")[0]}</span>
                      </button>
                    );
                  })}
                </div>

                {/* محتوى الركن المختار */}
                <div className="p-4">
                  {/* ────────────────── الركن الأول: مسار الأسلاك والشدّات ────────────────── */}
                  {currentPillar === "wires" && (
                    <div className="space-y-4">
                      {/* لوحة الأسلاك المباشرة على الكرسي (Chairside High-Contrast Wire Board) */}
                      {usesArchwires(row.appliance) ? (
                        <div className="rounded-2xl border-2 border-navy-800 bg-gradient-to-r from-navy-900 to-slate-900 p-4 text-white shadow-xs">
                          <div className="flex items-center justify-between border-b border-white/20 pb-2 mb-3">
                            <span className="text-xs font-bold text-navy-200">
                              الأسلاك الحالية على الكرسي
                            </span>
                            <span className="text-[11px] font-bold text-amber-300">
                              {SLOT_LABEL[row.slot]}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-3 text-center">
                            <div className="rounded-xl bg-white/10 p-3 backdrop-blur-xs">
                              <p className="text-xl font-black tracking-wider text-amber-400" dir="ltr">
                                {row.upperWire ?? "—"}
                              </p>
                              <p className="mt-1 text-xs font-bold text-navy-200">السلك العلوي (Upper)</p>
                            </div>
                            <div className="rounded-xl bg-white/10 p-3 backdrop-blur-xs">
                              <p className="text-xl font-black tracking-wider text-amber-400" dir="ltr">
                                {row.lowerWire ?? "—"}
                              </p>
                              <p className="mt-1 text-xs font-bold text-navy-200">السلك السفلي (Lower)</p>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {/* محدد المرحلة السريرية */}
                      {live ? (
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                          <p className="mb-2 text-[11px] font-extrabold text-slate-600">
                            المرحلة السريرية الحالية (انقر للتغيير):
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {PHASE_ORDER.map((phase) => (
                              <button
                                key={phase}
                                disabled={owner.drafts.get("case-patch")?.busy || owner.drafts.get("case-patch")?.uncertain} onClick={() => void patch(row.id, { phase })}
                                title={PHASE_HINT[phase]}
                                className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-all ${
                                  row.phase === phase
                                    ? "border-navy-800 bg-navy-800 text-white shadow-xs"
                                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                                }`}
                              >
                                {PHASE_LABEL[phase]}
                              </button>
                            ))}
                          </div>
                          <p className="mt-2 text-[11px] text-slate-500">
                            {PHASE_HINT[row.phase]}
                          </p>
                        </div>
                      ) : null}

                      {/* زر ونموذج تسجيل الشدّة */}
                      {live && (
                        <div>
                          {adjusting === row.id ? (
                            <AdjustmentForm
                              caseRow={row}
                              today={today}
                              wires={wires}
                              patientId={patientId}
                              onSaved={(result) => {
                                if (!owner.active || owner.denied) return;
                                disposeDraft(owner, `adjust:${row.id}`);
                                setAdjusting(null);
                                setSaved(result);
                                refreshAfterConfirmedChange();
                              }}
                              onError={safeError}
                            />
                          ) : (
                            <button
                              onClick={() => { if (!currentCase(row.id)) return; setSaved(null); setAdjusting(row.id); }}
                              className="w-full rounded-2xl bg-brand-orange py-3 text-sm font-black text-white shadow-xs hover:bg-amber-600 transition-colors"
                            >
                              ⚡ سجّل شدّة وجلسة جديدة الآن
                            </button>
                          )}
                        </div>
                      )}

                      {/* سجل الشدّات السابقة وألبومات الجلسات */}
                      {row.photosVisible === false ? (
                        <p role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                          صور الجلسات محجوبة حسب صلاحياتك. لا يمكن تحديد وجود الصور أو اكتمالها من هذا العرض.
                        </p>
                      ) : null}
                      {row.adjustments.length > 0 ? (
                        <div className="rounded-2xl border border-slate-200 bg-white p-4">
                          <h4 className="mb-3 text-xs font-extrabold text-navy-900">
                            سجل الشدّات السابقة وألبومات الجلسات ({row.adjustments.length})
                          </h4>
                          <ul className="space-y-2">
                            {row.adjustments.map((entry, index) => (
                              <li key={entry.id} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-xs font-extrabold text-navy-900">
                                    جلسة {row.adjustments.length - index} · {friendlyDateLong(entry.doneOn)}
                                  </span>
                                  <span className="text-xs font-bold text-slate-600">
                                    {entry.upperWire || entry.lowerWire ? (
                                      <>
                                        علوي <span dir="ltr" className="font-mono text-navy-800">{entry.upperWire ?? "—"}</span>
                                        {" · "}سفلي <span dir="ltr" className="font-mono text-navy-800">{entry.lowerWire ?? "—"}</span>
                                      </>
                                    ) : "—"}
                                  </span>
                                </div>
                                {entry.done ? <p className="mt-1 text-xs text-slate-700 font-medium">{entry.done}</p> : null}
                                <p className="mt-1 text-[11px] text-slate-500">
                                  {ELASTIC_LABEL[entry.elastics]}
                                  {entry.elasticNote ? ` · ${entry.elasticNote}` : ""}
                                  {" · القادم "}{friendlyDateLong(nextAdjustmentDate(entry.doneOn, entry.nextWeeks))}
                                  {" · "}{entry.recordedBy}
                                </p>

                                {/* صور الجلسة */}
                                {row.photosVisible !== false && entry.photos.length > 0 ? (
                                  <div className="mt-2.5 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                                    {entry.photos.map((photo) => (
                                      <a
                                        key={photo.id}
                                        href={`/api/documents/${photo.id}`}
                                        target="_blank"
                                        rel="noopener"
                                        className="group relative block overflow-hidden rounded-xl bg-slate-900 border border-slate-200"
                                      >
                                        {photo.isImage ? (
                                          <img
                                            src={`/api/documents/${photo.id}`}
                                            alt={photo.title}
                                            loading="lazy"
                                            className="h-20 w-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                                          />
                                        ) : (
                                          <div className="flex h-20 items-center justify-center text-2xl">📄</div>
                                        )}
                                        {photo.photoView && photo.photoView in PHOTO_VIEW_LABEL ? (
                                          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-bold text-white">
                                            {PHOTO_VIEW_LABEL[photo.photoView as PhotoView]}
                                          </span>
                                        ) : null}
                                      </a>
                                    ))}
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
                          لا توجد شدّات مسجلة بعد في هذه الحالة.
                        </p>
                      )}
                    </div>
                  )}

                  {/* ────────────────── الركن الثاني: السجلات والتشخيص السيفالومتري ────────────────── */}
                  {currentPillar === "diagnostics" && (
                    <div className="space-y-4">
                      {/* معرض سجلات الحالة والأشعة المعياري الـ 12 كمنصة WebCeph */}
                      <section>
                        <WebCephRecordsGrid
                          patientId={patientId}
                          orthoCaseId={row.id}
                          currentPhase={row.phase}
                          startDate={row.startDate}
                        />
                      </section>

                      {/* السيفالومتري ومخطط ويب سيف (WebCeph Station) */}
                      <section className="rounded-2xl border border-navy-100 bg-slate-50/50 p-3.5">
                        <PatientCeph
                          patientId={patientId}
                          orthoCaseId={row.id}
                          currentPhase={row.phase}
                          embedded={true}
                        />
                      </section>

                      {/* التوثيق الفوتوغرافي ومقارنة المراحل (Before / Progress / After) */}
                      <section className="rounded-2xl border border-slate-200 bg-white p-3.5">
                        <OrthoComparison patientId={patientId} orthoCaseId={row.id} photosVisible={row.photosVisible} />
                      </section>

                      {/* التحليل السريري للفكين وتصنيف الحالة (Malocclusion Diagnosis) */}
                      <section className="rounded-2xl border border-slate-200 bg-white p-3.5">
                        <PatientDiagnosis patientId={patientId} orthoCaseId={row.id} onError={safeError} />
                      </section>
                    </div>
                  )}

                  {/* ────────────────── الركن الثالث: الخطة والميكانيكا الحيوية ────────────────── */}
                  {currentPillar === "prescription" && (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <h4 className="mb-3 text-xs font-black text-navy-900">
                          وصفة الجهاز والمواصفات الميكانيكية
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">نوع الجهاز</span>
                            <span className="font-black text-navy-900">{APPLIANCE_LABEL[row.appliance]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">الفكّان المعالجان</span>
                            <span className="font-black text-navy-900">{ARCHES_LABEL[row.arches]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">مقاس الشق (Slot)</span>
                            <span className="font-black text-navy-900">{SLOT_LABEL[row.slot]}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">فلسفة البراكيت</span>
                            <span className="font-black text-navy-900 font-mono" dir="ltr">
                              {row.bracketSystem ?? "Roth / MBT"}
                            </span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">تاريخ البدء</span>
                            <span className="font-black text-navy-900">{friendlyDateLong(row.startDate)}</span>
                          </div>
                          <div className="rounded-xl bg-slate-50 p-2.5 border border-slate-100">
                            <span className="block text-[10px] text-slate-500 font-bold">المدة المخططة</span>
                            <span className="font-black text-navy-900">{row.plannedMonths} شهرًا</span>
                          </div>
                        </div>

                        {row.note && (
                          <div className="mt-3 rounded-xl bg-slate-50 p-3 border border-slate-100 text-xs">
                            <span className="block font-bold text-slate-500 mb-1">ملاحظات خطة العلاج والميكانيكا:</span>
                            <p className="text-slate-800">{row.note}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ────────────────── الركن الرابع: التثبيت والاستبقاء ────────────────── */}
                  {currentPillar === "retention" && (
                    <div className="space-y-4">
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <h4 className="text-xs font-black text-navy-900">
                            المثبّتات والاستقرار ومنع الارتداد (Relapse Prevention)
                          </h4>
                          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-black ${
                            row.retainer && row.retainer !== "none"
                              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                              : "bg-amber-50 text-amber-800 border-amber-200"
                          }`}>
                            {row.retainer ? RETAINER_LABEL[row.retainer] : "لم يُسجَّل مثبت بعد"}
                          </span>
                        </div>

                        {live && (
                          <div className="rounded-xl bg-slate-50 p-3 border border-slate-200">
                            <p className="mb-2 text-xs font-bold text-slate-700">
                              اختر نوع المثبّت المسلّم للمريض:
                            </p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {(Object.keys(RETAINER_LABEL) as RetainerType[]).map((type) => (
                                <button
                                  key={type}
                                  disabled={owner.drafts.get("case-patch")?.busy || owner.drafts.get("case-patch")?.uncertain} onClick={() => void patch(row.id, { retainer: type })}
                                  className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-all ${
                                    row.retainer === type
                                      ? "border-emerald-600 bg-emerald-600 text-white shadow-xs"
                                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                                  }`}
                                >
                                  {RETAINER_LABEL[type]}
                                </button>
                              ))}
                            </div>

                            <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                              <button
                                onClick={async () => {
                                  if (!currentCase(row.id) || owner.drafts.get("case-patch")?.busy || owner.drafts.get("case-patch")?.uncertain) return;
                                  const note = window.prompt("ملاحظة على إكمال الحالة (اختياري)");
                                  if (note === null) return;
                                  await patch(row.id, { status: "completed", note });
                                }}
                                className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-black text-white hover:bg-emerald-700 shadow-xs transition-colors"
                              >
                                ✓ أُكملت الحالة بنجاح وسُلّم المثبت
                              </button>
                              <button
                                onClick={async () => {
                                  if (!currentCase(row.id) || owner.drafts.get("case-patch")?.busy || owner.drafts.get("case-patch")?.uncertain) return;
                                  const note = window.prompt("سبب التوقّف أو الإلغاء؟");
                                  if (!note?.trim()) return;
                                  await patch(row.id, { status: "discontinued", note });
                                }}
                                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                              >
                                توقّفت الحالة
                              </button>
                            </div>
                          </div>
                        )}

                        {row.closedAt && (
                          <div className="rounded-xl bg-slate-100 p-3 text-xs text-slate-700">
                            <p className="font-bold">
                              أُغلقت الحالة في {friendlyDateLong(row.closedAt.slice(0, 10))} بواسطة {row.closedBy}
                            </p>
                            {row.closedNote && <p className="mt-1 text-slate-600">{row.closedNote}</p>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ═══════════════ الجلسة القادمة المقترحة — إغلاق الحلقة ═══════════════ */

/**
 * (VISIT-FLOW-1) الشدّة سُجّلت في زيارة اليوم — والزيارة تُغلق عند الطبيب لا عند الاستقبال.
 *
 * التوقيع من هنا يكتفي بالشدّة المسجّلة (لا إجراء مسعَّر يُطلب)، ويُنهي الجلوس ويحرّر الكرسي،
 * فيصل المريض إلى الاستقبال وزيارته موقّعة: تراها «ماذا أُنجز اليوم» وتحصّل أو تؤجّل فقط.
 * من أراد إضافة إجراءٍ أو تشخيص يفتح «زيارة اليوم» ويوقّع من هناك.
 */
function SignTodayVisitCard({ visitId, onError }: { visitId: number; onError: (message: string | null) => void }) {
  const form = useOrthoDraft(`sign:${visitId}`);
  const session = useSession();
  const canSign = session?.role === "doctor" || session?.role === "admin";
  const busy = form.draft.busy;
  const [signed] = form.field("signed", false);

  const sign = async () => {
    const operation = form.begin(canSign && form.draft.values.get("signed") !== true && (form.owner.standalone || form.owner.cases.some((row) => row.adjustments.some((entry) => entry.visitId === visitId && !entry.visitSigned))));
    if (!operation) return;
    onError(null);
    try {
      const response = await fetch(`/api/visits/${visitId}/clinical`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sign" }),
      });
      if (!form.checkHeaders(response, operation)) return;
      const payload = await response.json().catch(() => null);
      if (!form.current(operation)) return;
      if (!response.ok) { if (response.status >= 500) form.uncertain(); onError(payload?.message ?? "تعذّر توقيع الزيارة."); return; }
      form.commit("signed", true);
    } catch {
      if (form.current(operation)) { form.uncertain(); onError("تعذّر تأكيد توقيع الزيارة. أعد قراءة السجل قبل المحاولة."); }
    } finally {
      form.finish(operation);
    }
  };

  return (
    <div className="rounded-2xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-950 shadow-xs">
      <UncertainWrite draft={form.draft} />
      {signed ? (
        <p className="font-black">✓ وُقّعت زيارة اليوم وأُرسل المريض إلى الاستقبال.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-bold">سُجّلت الشدّة في زيارة اليوم.</p>
          {canSign ? (
            <button type="button" onClick={() => void sign()} disabled={busy || form.draft.uncertain}
              className="rounded-xl bg-sky-700 px-3 py-2 text-xs font-black text-white hover:bg-sky-800 disabled:opacity-60">
              {busy ? "جارٍ التوقيع…" : "وقّع الزيارة وأرسله للاستقبال"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function NextAppointmentCard({
  patientId, patientName, patientPhone, caseId, doneOn, nextWeeks,
  photosUploaded, onDismiss, onError, draftKey, contactReady,
}: {
  patientId: number; patientName: string; patientPhone: string | null;
  caseId: number; doneOn: string; nextWeeks: number; photosUploaded: number;
  draftKey: string; contactReady: boolean;
  onDismiss: () => void; onError: (message: string | null) => void;
}) {
  const form = useOrthoDraft(draftKey, patientId, caseId);
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const suggested = nextAdjustmentDate(doneOn, nextWeeks);
  const [booking, setBooking] = form.field("booking", false);
  const [date, setDate] = form.field("date", suggested);
  const [time, setTime] = form.field("time", "16:00");
  const busy = form.draft.busy;
  const [booked] = form.field<{ date: string; time: string } | null>("booked", null);
  // The card survives Back/success, but a captured form command must not.
  // Retained draft values alone cannot distinguish two separate form openings.
  const bookingView = useMemo(() => ({ active: false }), [booking, form.draft]);
  useLayoutEffect(() => {
    bookingView.active = booking;
    return () => { bookingView.active = false; };
  }, [bookingView, booking]);
  const currentBookingView = () => bookingView.active && form.draft.values.get("booking") === true
    && !form.draft.values.get("booked");

  const message = booked
    ? orthoSessionBookedText({
        patientName: patientName || "المريض",
        whenText: `${friendlyDateLong(booked.date)} الساعة ${friendlyTime(booked.time)}`,
        clinic: { name: clinicName, phone: clinicPhone || "04-253028" },
      })
    : null;
  const waLink = contactReady && booked && patientPhone
    ? (() => {
        const number = toWhatsAppNumber(patientPhone);
        return number
          ? `https://wa.me/${number}?text=${encodeURIComponent(message ?? "")}`
          : null;
      })()
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const operation = form.begin(currentBookingView() && contactReady && form.owner.contact);
    if (!operation) return;
    onError(null);
    try {
      const response = await fetch("/api/appointments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, date, time, durationMinutes: 15,
          appointmentType: "follow_up",
          note: "جلسة شدّ تقويم — من كابينة التقويم",
        }),
      });
      if (!form.checkHeaders(response, operation)) return;
      const payload = await response.json().catch(() => null);
      if (!form.current(operation)) return;
      if (!response.ok) {
        if (response.status >= 500) form.uncertain();
        onError(payload?.suggestionMessage || payload?.message || "تعذّر الحجز.");
        return;
      }
      form.commit("booked", { date, time });
      bookingView.active = false;
      form.commit("booking", false);
    } catch {
      if (form.current(operation)) { form.uncertain(); onError("تعذّر تأكيد نتيجة الحجز. راجع المواعيد قبل تكراره."); }
    } finally {
      form.finish(operation);
    }
  };

  return (
    <div className="rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4 shadow-xs">
      <p className="mb-1 text-sm font-black text-emerald-900">
        {booked ? "تم حجز الجلسة القادمة بنجاح" : "📅 الجلسة القادمة المقترحة"}
      </p>
      <UncertainWrite draft={form.draft} />
      {!contactReady ? <p role="status">الحجز والتذكير متوقفان حتى التحقق من بيانات المريض.</p> : null}
      {photosUploaded > 0 ? (
        <p className="mb-1 text-xs font-bold text-emerald-700">
          📷 رُفعت {photosUploaded} صورة للجلسة وحُفظت مباشرة في ألبوم الحالة.
        </p>
      ) : null}
      <p className="mb-2 text-xs text-emerald-800">
        {friendlyDateLong(booked?.date ?? suggested)} — متابعة تقويم وشد · 15 دقيقة
        {booked ? ` · الساعة ${friendlyTime(booked.time)}` : ""}
      </p>

      {booked ? (
        <>
          {contactReady && waLink && message ? (
            <div className="flex flex-wrap gap-2">
              <a href={waLink} target="_blank" rel="noopener"
                className="flex-1 rounded-xl bg-emerald-600 py-2 text-center text-xs font-black text-white hover:bg-emerald-700 transition-colors">
                أرسل تأكيد الموعد واتساب
              </a>
              <button type="button"
                onClick={() => { if (form.editable() && form.owner.contact) void navigator.clipboard?.writeText(message).catch(() => {}); }}
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
                انسخ الرسالة
              </button>
            </div>
          ) : null}
          <button onClick={() => { if (form.editable()) onDismiss(); }}
            className="mt-2 w-full rounded-xl border border-emerald-300 bg-white py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
            تم — إغلاق
          </button>
        </>
      ) : !booking ? (
        <div className="flex flex-wrap gap-2">
          <button disabled={!contactReady || busy || form.draft.uncertain} onClick={() => {
            if (form.editable() && !form.draft.values.get("booking") && !form.draft.values.get("booked")) setBooking(true);
          }}
            className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-xs font-black text-white hover:bg-emerald-700 transition-colors">
            📅 حجز الموعد المقترح الآن
          </button>
          <button onClick={() => { if (form.editable()) onDismiss(); }}
            className="rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50">
            لاحقًا
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="rounded-xl border border-emerald-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            <label className="min-w-[9rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">التاريخ المقترح</span>
              <input type="date" value={date} onChange={(event) => { if (currentBookingView()) setDate(event.target.value); }}
                aria-label="تاريخ الجلسة القادمة"
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
            </label>
            <label className="w-32">
              <span className="mb-1 block text-[10px] font-bold text-slate-500">الوقت</span>
              <input type="time" value={time} onChange={(event) => { if (currentBookingView()) setTime(event.target.value); }}
                aria-label="وقت الجلسة القادمة"
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || form.draft.uncertain || !contactReady || !date || !time}
              className="flex-1 rounded-xl bg-emerald-600 py-2 text-xs font-black text-white disabled:opacity-50">
              {busy ? "جارٍ الحجز…" : "أكّد الحجز"}
            </button>
            <button type="button" onClick={() => {
              if (!form.editable() || !currentBookingView()) return;
              bookingView.active = false; setBooking(false);
            }}
              className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600">
              رجوع
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ═══════════════ نماذج الحالة والشدّة ═══════════════ */

function NewCase({ patientId, today, onSaved, onError }: {
  patientId: number; today: string; onSaved: () => void; onError: (message: string | null) => void;
}) {
  const form = useOrthoDraft("new", patientId);
  const [appliance, setAppliance] = form.field<Appliance>("appliance", "fixed_metal");
  const [arches, setArches] = form.field<Arches>("arches", "both");
  const [slot, setSlot] = form.field<SlotSize>("slot", "022");
  const [bracketSystem, setBracketSystem] = form.field("bracketSystem", "MBT");
  const [startDate, setStartDate] = form.field("startDate", today);
  const [plannedMonths, setPlannedMonths] = form.field("plannedMonths", "18");
  const saving = form.draft.busy;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || form.draft.uncertain) return;
    const operation = form.begin(!form.owner.cases.some((row) => row.status === "active" || row.status === "retention"));
    if (!operation) return;
    onError(null);
    try {
      const response = await fetch("/api/ortho", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, appliance, arches, slot, bracketSystem, startDate,
          plannedMonths: Number(plannedMonths) || 18,
        }),
      });
      if (!form.checkHeaders(response, operation)) return;
      const payload = await response.json().catch(() => null);
      if (!form.current(operation)) return;
      if (!response.ok) { if (response.status >= 500) form.uncertain(); onError(payload?.message ?? "تعذّر الفتح."); return; }
      onSaved();
    } catch {
      if (form.current(operation)) { form.uncertain(); onError("تعذّر تأكيد نتيجة الحفظ. راجع الحالة قبل تكرار الطلب."); }
    } finally {
      form.finish(operation);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-navy-800 bg-white p-4 shadow-xs">
      <UncertainWrite draft={form.draft} />
      <h3 className="mb-3 text-sm font-black text-navy-900">فتح حالة تقويم جديدة</h3>
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الجهاز</span>
          <select value={appliance} onChange={(event) => setAppliance(event.target.value as Appliance)}
            aria-label="نوع الجهاز"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(APPLIANCE_LABEL) as Appliance[]).map((value) => (
              <option key={value} value={value}>{APPLIANCE_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[7rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الفكّان</span>
          <select value={arches} onChange={(event) => setArches(event.target.value as Arches)}
            aria-label="الفكّان المعالَجان"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(ARCHES_LABEL) as Arches[]).map((value) => (
              <option key={value} value={value}>{ARCHES_LABEL[value]}</option>
            ))}
          </select>
        </label>
      </div>

      {usesArchwires(appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[7rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الشقّ</span>
            <select value={slot} onChange={(event) => setSlot(event.target.value as SlotSize)}
              aria-label="مقاس الشقّ"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
              {(Object.keys(SLOT_LABEL) as SlotSize[]).map((value) => (
                <option key={value} value={value}>{SLOT_LABEL[value]}</option>
              ))}
            </select>
          </label>
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">نظام البراكيت</span>
            <input value={bracketSystem} onChange={(event) => setBracketSystem(event.target.value)}
              aria-label="نظام البراكيت" dir="ltr"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
          </label>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ البدء</span>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            aria-label="تاريخ بدء التقويم"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-32">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المدة (أشهر)</span>
          <input value={plannedMonths} onChange={(event) => setPlannedMonths(event.target.value)}
            aria-label="المدة المتوقعة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>

      <button type="submit" disabled={saving || form.draft.uncertain}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-xs font-black text-white disabled:opacity-50">
        افتح الحالة
      </button>
    </form>
  );
}

export function AdjustmentForm({ caseRow, today, wires, patientId, onSaved, onError }: {
  caseRow: OrthoCase; today: string; wires: { code: string }[]; patientId: number;
  onSaved: (result: {
    adjustmentId: number; caseId: number; doneOn: string;
    nextWeeks: number; photosUploaded: number; visitId: number | null;
  }) => void;
  onError: (message: string | null) => void;
}) {
  const form = useOrthoDraft(`adjust:${caseRow.id}`, patientId, caseRow.id);
  const [doneOn, setDoneOn] = form.field("doneOn", today);
  // Recording a session must not advance either arch without an explicit selection.
  const [upperWire, setUpperWire] = form.field("upperWire", caseRow.upperWire ?? "");
  const [lowerWire, setLowerWire] = form.field("lowerWire", caseRow.lowerWire ?? "");
  const previousAdjustment = caseRow.adjustments[0] ?? null;
  // The baseline stores a description, not an elastic class. Never infer one from its text.
  const baselineElasticNote = previousAdjustment ? "" : caseRow.elastics?.trim() ?? "";
  const [elastics, setElastics] = form.field<ElasticClass | "">("elastics",
    previousAdjustment?.elastics ?? (baselineElasticNote ? "" : "none"),
  );
  const [elasticNote, setElasticNote] = form.field("elasticNote", previousAdjustment ? previousAdjustment.elasticNote ?? "" : baselineElasticNote);
  const [done, setDone] = form.field("done", "");
  const [nextWeeks, setNextWeeks] = form.field("nextWeeks", String(previousAdjustment?.nextWeeks ?? 4));
  const saving = form.draft.busy;

  const [queue, setQueue] = form.field<QueuedPhoto[]>("queue", []);
  const [stage, setStage] = form.field<PhotoStage>("stage", () =>
    suggestPhotoStage({
      date: today, startDate: caseRow.startDate, phase: caseRow.phase,
      isFirstSession: caseRow.adjustments.length === 0,
    }),
  );
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files || !form.editable() || !mayUpload(form.session)) return;
    const added: QueuedPhoto[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const preview = URL.createObjectURL(file); form.draft.urls.add(preview);
      added.push({ file, preview, view: "" });
    }
    if (added.length > 0) setQueue((current) => [...current, ...added]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!elastics) {
      if (form.editable()) onError("اختر صنف المطاطات لهذه الجلسة؛ وصف خط الأساس لا يحدّد الصنف تلقائيًا.");
      return;
    }
    const operation = form.begin(caseRow.status === "active" || caseRow.status === "retention");
    if (!operation) return;
    const submittedPhotos = [...queue];
    onError(null);
    try {
      const response = await fetch(`/api/ortho/${caseRow.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doneOn, upperWire, lowerWire, elastics, elasticNote, done,
          nextWeeks: Number(nextWeeks) || 4 }),
      });
      if (!form.checkHeaders(response, operation)) return;
      const payload = await response.json().catch(() => null);
      if (!form.current(operation)) return;
      if (!response.ok) {
        if (response.status >= 500) form.uncertain();
        onError(payload?.message ?? "تعذّر التسجيل."); return;
      }
      const adjustmentId = payload?.id;
      if (!Number.isSafeInteger(adjustmentId) || adjustmentId <= 0) {
        form.uncertain(); onError("تم قبول الطلب دون مرجع شدّة يمكن التحقق منه. راجع السجل قبل أي محاولة جديدة."); return;
      }
      const visitId = Number.isInteger(payload?.visitId) && payload.visitId > 0 ? Number(payload.visitId) : null;
      let uploaded = 0; let failed = 0;
      for (const photo of submittedPhotos) {
        if (!form.current(operation)) return;
        // A refresh is not authority to start another command. Preserve the
        // queued files and the no-replay latch if the submitted chain is interrupted.
        if (!form.caseGranted() || !mayUpload(form.session)) {
          form.uncertain(); onError("سُجّلت الشدّة؛ توقف رفع الصور حتى مراجعة الصلاحية والسجل. لا تعِد تسجيل الشدّة."); return;
        }
        try {
          const uploadForm = new FormData();
          uploadForm.set("file", photo.file);
          uploadForm.set("kind", "photo");
          uploadForm.set("title", `صورة جلسة ${friendlyDateLong(doneOn)}`);
          uploadForm.set("takenOn", doneOn);
          uploadForm.set("orthoCaseId", String(caseRow.id));
          uploadForm.set("adjustmentId", String(adjustmentId));
          uploadForm.set("photoStage", stage);
          if (photo.view) uploadForm.set("photoView", photo.view);
          const upload = await fetch(`/api/patients/${patientId}/documents`, { method: "POST", body: uploadForm });
          if (!form.checkHeaders(upload, operation)) return;
          if (upload.ok) uploaded++; else failed++;
        } catch {
          if (!form.current(operation)) return;
          failed++;
        }
      }
      if (!form.current(operation)) return;
      if (failed > 0) onError(`رُفعت ${uploaded} صورة وفشل ${failed} — أعد المحاولة من المستندات.`);
      for (const photo of submittedPhotos) form.release(photo.preview);
      form.commit("queue", []);
      onSaved({ adjustmentId, caseId: caseRow.id, doneOn, nextWeeks: Number(nextWeeks) || 4, photosUploaded: uploaded, visitId });
    } catch {
      if (form.current(operation)) { form.uncertain(); onError("تعذّر تأكيد نتيجة تسجيل الشدّة. راجع السجل قبل تكرارها."); }
    } finally { form.finish(operation); }
  };

  const options = [...new Set([...wires.map((wire) => wire.code),
    upperWire, lowerWire, caseRow.upperWire, caseRow.lowerWire].filter(Boolean) as string[])];

  const fullSet = caseRow.photosVisible === false ? null : fullPhotoSetCheck({
    sessionDate: doneOn,
    startDate: caseRow.startDate,
    lastFullSetDate: caseRow.adjustments.find((entry) =>
      entry.photos.some((photo) => photo.photoStage === "initial"))?.doneOn ?? null,
    intervalMonths: 6,
    phase: caseRow.phase,
    capturedViews: queue.map((photo) => photo.view).filter((view): view is PhotoView => view !== ""),
  });

  return (
    <form onSubmit={submit} className="rounded-2xl border border-brand-orange bg-orange-50/50 p-4 shadow-xs">
      <p className="mb-2 text-xs font-black text-slate-800">تسجيل شدّة وتعديل جديد</p>
      <UncertainWrite draft={form.draft} />

      {usesArchwires(caseRow.appliance) ? (
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك العلوي {caseRow.upperWire ? `(الحالي ${caseRow.upperWire})` : ""}
            </span>
            <select value={upperWire} onChange={(event) => setUpperWire(event.target.value)}
              aria-label="السلك العلوي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">
              السلك السفلي {caseRow.lowerWire ? `(الحالي ${caseRow.lowerWire})` : ""}
            </span>
            <select value={lowerWire} onChange={(event) => setLowerWire(event.target.value)}
              aria-label="السلك السفلي" dir="ltr"
              className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-mono">
              <option value="">— بلا تغيير —</option>
              {options.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      {baselineElasticNote ? (
        <p role="status" data-testid="adjustment-baseline-elastics"
          className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-950">
          وصف المطاطات المحفوظ في خط الأساس: {baselineElasticNote}.
          اختر الصنف لهذه الجلسة، أو «بلا مطاطات» إذا لم تعد تُستخدم. لا يُستنتج الصنف من الوصف.
        </p>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">المطاطات</span>
          <select value={elastics} onChange={(event) => {
            const value = event.target.value as ElasticClass | "";
            setElastics(value);
            if (value === "none") setElasticNote("");
          }}
            aria-label="صنف المطاطات" required
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {baselineElasticNote ? <option value="">— اختر الصنف دون تغيير الوصف المحفوظ —</option> : null}
            {(Object.keys(ELASTIC_LABEL) as ElasticClass[]).map((value) => (
              <option key={value} value={value}>{ELASTIC_LABEL[value]}</option>
            ))}
          </select>
        </label>
        {elastics !== "none" || elasticNote ? (
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-[10px] font-bold text-slate-500">وصف المطاطات</span>
            <input value={elasticNote} onChange={(event) => setElasticNote(event.target.value)}
              aria-label="وصف المطاطات" placeholder="3/16 خفيفة — ليلًا"
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
          </label>
        ) : null}
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] font-bold text-slate-500">ما نُفّذ</span>
        <input value={done} onChange={(event) => setDone(event.target.value)}
          aria-label="ما نُفّذ في الشدّة" placeholder="تبديل السلك وربط الأربطة وتثبيت المطاطات"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
      </label>

      {/* صور الجلسة */}
      <div className="mb-2 rounded-xl border border-slate-200 bg-white p-3">
        <p className="mb-1.5 text-xs font-black text-slate-700">📷 صور الجلسة والكاميرا</p>
        {caseRow.photosVisible === false ? (
          <p role="status" className="mb-1.5 text-[10px] text-slate-600">
            صور الجلسات السابقة محجوبة حسب صلاحياتك؛ لا يمكن تقييم اكتمال التوثيق الصوري.
          </p>
        ) : null}
        {fullSet?.required ? (
          <p className="mb-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
            {fullSet.reason}
            {fullSet.missingViews.length > 0 ? ` — ناقص: ${fullSet.missingViews.map((view) => PHOTO_VIEW_LABEL[view]).join("، ")}` : ""}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={saving || form.draft.uncertain || !mayUpload(form.session)} onClick={() => { if (form.editable() && mayUpload(form.session)) cameraInput.current?.click(); }}
            className="min-w-[10rem] flex-1 rounded-xl bg-navy-800 py-2.5 text-xs font-black text-white hover:bg-navy-900">
            📷 التقط بالكاميرا الآن
          </button>
          <button type="button" disabled={saving || form.draft.uncertain || !mayUpload(form.session)} onClick={() => { if (form.editable() && mayUpload(form.session)) galleryInput.current?.click(); }}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50">
            اختيار من المعرض
          </button>
        </div>

        <input ref={cameraInput} type="file" accept="image/*" capture="environment"
          aria-label="كاميرا الجلسة" className="sr-only"
          onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
        <input ref={galleryInput} type="file" accept="image/*" multiple
          aria-label="اختيار صور" className="sr-only"
          onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />

        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">دور الصور المرفوعة</span>
          <select value={stage} onChange={(event) => setStage(event.target.value as PhotoStage)}
            aria-label="دور صور الجلسة"
            className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
            {(Object.keys(PHOTO_STAGE_LABEL) as PhotoStage[]).map((value) => (
              <option key={value} value={value}>{PHOTO_STAGE_LABEL[value]}</option>
            ))}
          </select>
        </label>

        {queue.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {queue.map((photo, index) => (
              <li key={photo.preview} className="flex items-center gap-2 rounded-lg bg-slate-50 p-1.5">
                <img src={photo.preview} alt="صورة الجلسة" className="h-12 w-12 rounded-lg object-cover" />
                <select value={photo.view}
                  onChange={(event) => {
                    const view = event.target.value as PhotoView | "";
                    setQueue((current) => current.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, view } : row));
                  }}
                  aria-label="وجه الصورة"
                  className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px]">
                  <option value="">— وجه الصورة (اختياري) —</option>
                  {(Object.keys(PHOTO_VIEW_LABEL) as PhotoView[]).map((view) => (
                    <option key={view} value={view}>{PHOTO_VIEW_LABEL[view]}</option>
                  ))}
                </select>
                <button type="button"
                  onClick={() => {
                    if (!form.editable()) return;
                    form.release(photo.preview);
                    setQueue((current) => current.filter((_, rowIndex) => rowIndex !== index));
                  }}
                  className="text-[11px] font-bold text-red-500">حذف</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        <label className="min-w-[9rem] flex-1">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">تاريخ الشدّة</span>
          <input type="date" value={doneOn} onChange={(event) => setDoneOn(event.target.value)}
            aria-label="تاريخ الشدّة"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label className="w-36">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">القادمة بعد (أسابيع)</span>
          <input value={nextWeeks} onChange={(event) => setNextWeeks(event.target.value)}
            aria-label="أسابيع حتى الشدّة القادمة" inputMode="numeric" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
      </div>

      <p className="mb-2 text-[10px] text-slate-500">
        الموعد المقترح: {friendlyDateLong(nextAdjustmentDate(doneOn, Number(nextWeeks) || 4))}
      </p>

      <button type="submit" disabled={saving || form.draft.uncertain}
        className="w-full rounded-xl bg-brand-orange py-2.5 text-xs font-black text-white hover:bg-amber-600 disabled:opacity-50">
        {saving ? "جارٍ الحفظ والرفع…" : "احفظ الشدّة والصور"}
      </button>
    </form>
  );
}

/* ═══════════════ مقارنة Before / Progress / After ═══════════════ */

export function OrthoComparison({ photosVisible, ...props }: {
  patientId: number; orthoCaseId: number; photosVisible?: boolean;
}) {
  if (photosVisible === false) {
    return (
      <p role="status" className="text-xs text-slate-600">
        صور الجلسات محجوبة حسب صلاحياتك. لا يمكن تحديد وجود الصور أو مقارنة مراحلها من هذا العرض.
      </p>
    );
  }
  return <OrthoComparisonContent {...props} />;
}

function OrthoComparisonContent({ patientId, orthoCaseId }: { patientId: number; orthoCaseId: number }) {
  const [photos, setPhotos] = useState<StagePhoto[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error("تعذّر التحميل.");
      const documents = (payload.documents ?? []) as {
        id: number; isImage: boolean; orthoCaseId: number | null;
        photoStage: string | null; photoView: string | null;
        takenOn: string | null; uploadedAt: string;
      }[];
      setPhotos(documents
        .filter((document) => document.orthoCaseId === orthoCaseId && document.isImage)
        .map((document) => ({
          id: document.id,
          stage: (document.photoStage ?? "progress") as PhotoStage,
          view: (document.photoView ?? null) as PhotoView | null,
          takenOn: document.takenOn,
          uploadedAt: document.uploadedAt,
        })));
    } catch {
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [patientId, orthoCaseId]);

  useEffect(() => { void load(); }, [load]);

  const columns = useMemo(() => buildComparison(photos), [photos]);
  const withPhotos = columns.filter((column) => column.count > 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-black text-navy-900 flex items-center gap-1.5">
          <span>📸</span> التوثيق الفوتوغرافي ومقارنة المراحل (Before / Progress / After)
        </h4>
        <span className="text-[10px] text-slate-500 font-bold">
          {photos.length} صورة مسجلة
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-slate-400">جارٍ التحميل…</p>
      ) : withPhotos.length < 2 ? (
        <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 text-center">
          التقط صورًا في مراحل التقويم المختلفة (ما قبل العلاج، أثناء الشدّات، وبعد العلاج) لتفعيل المقارنة التطورية الفورية.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {withPhotos.map((column) => (
            <div key={column.stage} className="text-center rounded-xl bg-slate-50 p-2 border border-slate-100">
              <p className="mb-1 text-[11px] font-bold text-slate-700">{column.label}</p>
              {column.featured ? (
                <a href={`/api/documents/${column.featured.id}`} target="_blank" rel="noopener">
                  <img src={`/api/documents/${column.featured.id}`}
                    alt={column.label}
                    className="aspect-square w-full rounded-xl bg-slate-900 object-cover" />
                </a>
              ) : (
                <div className="aspect-square w-full rounded-xl bg-slate-200" />
              )}
              <p className="mt-1 text-[10px] text-slate-500">{column.count} صورة</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════ (CASE-1) الحالة السابقة (قبل النظام) ═══════════════ */

function LegacyBaselineSummary({ row }: { row: OrthoCase }) {
  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-950">
      <p className="font-extrabold">
        حالة سابقة سُجّلت
        {row.baselineRecordedAt ? ` في ${friendlyDateLong(row.baselineRecordedAt.slice(0, 10))}` : ""}
        {" "}— لا فواتير ولا زيارات قبلها في النظام.
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {row.responsibleDoctorName ? <span>الطبيب المسؤول: <b>{row.responsibleDoctorName}</b></span> : null}
        {row.elastics ? <span>المطاطات: <b>{row.elastics}</b></span> : null}
        {row.legacyFinancialMode ? (
          <span>المال قبل النظام: <b>{LEGACY_FINANCIAL_LABEL[row.legacyFinancialMode]}</b></span>
        ) : null}
      </div>
      {row.legacyFinancialMode ? (
        <p className="mt-1 text-amber-800">{LEGACY_FINANCIAL_HINT[row.legacyFinancialMode]}</p>
      ) : null}
      {row.remainingObjectives ? (
        <p className="mt-1 whitespace-pre-line"><b>الأهداف المتبقية:</b> {row.remainingObjectives}</p>
      ) : null}
    </div>
  );
}

function LegacyBaselineForm({ patientId, today, onSaved, onError }: {
  patientId: number; today: string; onSaved: () => void; onError: (message: string | null) => void;
}) {
  const form = useOrthoDraft("baseline", patientId);
  const [appliance, setAppliance] = form.field<Appliance>("appliance", "fixed_metal");
  const [arches, setArches] = form.field<Arches>("arches", "both");
  const [slot, setSlot] = form.field<SlotSize>("slot", "022");
  const [phase, setPhase] = form.field<OrthoPhase>("phase", "working");
  const [upperWire, setUpperWire] = form.field("upperWire", "");
  const [lowerWire, setLowerWire] = form.field("lowerWire", "");
  const [elastics, setElastics] = form.field("elastics", "");
  const [monthsElapsed, setMonthsElapsed] = form.field("monthsElapsed", "6");
  const [monthsRemaining, setMonthsRemaining] = form.field("monthsRemaining", "12");
  const [financialMode, setFinancialMode] = form.field<LegacyFinancialMode | "">("financialMode", "");
  const [objectives, setObjectives] = form.field("objectives", "");
  const [doctorId, setDoctorId] = form.field("doctorId", "");
  const [doctors, setDoctors] = useState<{ id: number; name: string }[]>([]);
  const saving = form.draft.busy;

  useEffect(() => {
    let alive = true;
    void fetch("/api/parties?kind=doctor", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!alive || !payload) return;
        const list = Array.isArray(payload) ? payload : payload.balances ?? [];
        setDoctors(list.map((one: { id: number; name: string }) => ({ id: one.id, name: one.name })));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const elapsedNumber = Number(monthsElapsed);
  const derivedStart = Number.isInteger(elapsedNumber) && elapsedNumber >= 0 && elapsedNumber <= 120
    ? monthsBefore(today, elapsedNumber) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || form.draft.uncertain) return;
    if (!financialMode) { onError("اختر كيف عومل المال قبل النظام."); return; }
    const operation = form.begin((form.session?.role === "admin" || form.session?.role === "doctor") && !form.owner.cases.some((row) => row.status === "active" || row.status === "retention"));
    if (!operation) return;
    onError(null);
    try {
      const response = await fetch("/api/ortho/baseline", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId, appliance, arches, slot, phase, upperWire, lowerWire, elastics,
          monthsElapsed: Number(monthsElapsed), monthsRemaining: Number(monthsRemaining),
          financialMode, remainingObjectives: objectives,
          responsibleDoctorId: doctorId ? Number(doctorId) : null,
        }),
      });
      if (!form.checkHeaders(response, operation)) return;
      const payload = await response.json().catch(() => null);
      if (!form.current(operation)) return;
      if (!response.ok) { if (response.status >= 500) form.uncertain(); onError(payload?.message ?? "تعذّر التسجيل."); return; }
      onSaved();
    } catch {
      if (form.current(operation)) { form.uncertain(); onError("تعذّر تأكيد نتيجة الحفظ. راجع الحالة قبل تكرار الطلب."); }
    } finally {
      form.finish(operation);
    }
  };

  const field = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs";
  const label = "mb-1 block text-[10px] font-bold text-slate-500";

  return (
    <form onSubmit={submit} className="rounded-2xl border border-amber-300 bg-white p-4 shadow-xs">
      <UncertainWrite draft={form.draft} />
      <h3 className="text-sm font-black text-navy-900">تسجيل حالة سابقة (قبل النظام)</h3>
      <p className="mb-3 text-[11px] text-slate-500">
        لقطةٌ لحال العلاج اليوم — لا تُنشأ فواتير ولا زيارات عن الماضي.
      </p>

      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label>
          <span className={label}>الجهاز</span>
          <select value={appliance} onChange={(event) => setAppliance(event.target.value as Appliance)}
            aria-label="نوع الجهاز" className={field}>
            {(Object.keys(APPLIANCE_LABEL) as Appliance[]).map((value) => (
              <option key={value} value={value}>{APPLIANCE_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={label}>الفكّان</span>
          <select value={arches} onChange={(event) => setArches(event.target.value as Arches)}
            aria-label="الفكّان المعالَجان" className={field}>
            {(Object.keys(ARCHES_LABEL) as Arches[]).map((value) => (
              <option key={value} value={value}>{ARCHES_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={label}>الشقّ</span>
          <select value={slot} onChange={(event) => setSlot(event.target.value as SlotSize)}
            aria-label="مقاس الشقّ" className={field}>
            {(Object.keys(SLOT_LABEL) as SlotSize[]).map((value) => (
              <option key={value} value={value}>{SLOT_LABEL[value]}</option>
            ))}
          </select>
        </label>
        <label>
          <span className={label}>المرحلة الحالية</span>
          <select value={phase} onChange={(event) => setPhase(event.target.value as OrthoPhase)}
            aria-label="المرحلة الحالية" className={field}>
            {PHASE_ORDER.map((value) => <option key={value} value={value}>{PHASE_LABEL[value]}</option>)}
          </select>
        </label>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label>
          <span className={label}>السلك العلوي الحالي</span>
          <input value={upperWire} onChange={(event) => setUpperWire(event.target.value)} list="legacy-wires"
            aria-label="السلك العلوي الحالي" dir="ltr" className={`${field} font-mono`} />
        </label>
        <label>
          <span className={label}>السلك السفلي الحالي</span>
          <input value={lowerWire} onChange={(event) => setLowerWire(event.target.value)} list="legacy-wires"
            aria-label="السلك السفلي الحالي" dir="ltr" className={`${field} font-mono`} />
        </label>
        <label>
          <span className={label}>منذ كم شهرًا بدأ</span>
          <input value={monthsElapsed} onChange={(event) => setMonthsElapsed(event.target.value)}
            aria-label="الأشهر المنقضية" inputMode="numeric" dir="ltr" className={field} />
        </label>
        <label>
          <span className={label}>الأشهر المتبقية</span>
          <input value={monthsRemaining} onChange={(event) => setMonthsRemaining(event.target.value)}
            aria-label="الأشهر المتبقية" inputMode="numeric" dir="ltr" className={field} />
        </label>
      </div>
      <datalist id="legacy-wires">
        {wiresFor(slot).map((wire) => <option key={wire.code} value={wire.code} />)}
      </datalist>
      {derivedStart ? (
        <p className="mb-2 text-[11px] text-slate-500">بدء تقريبي: {friendlyDateLong(derivedStart)}</p>
      ) : null}

      <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label>
          <span className={label}>المطاطات الحالية</span>
          <input value={elastics} onChange={(event) => setElastics(event.target.value)}
            aria-label="المطاطات الحالية" placeholder="صنف ثانٍ 3/16 — ليلًا" className={field} />
        </label>
        <label>
          <span className={label}>الطبيب المسؤول</span>
          <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)}
            aria-label="الطبيب المسؤول" className={field}>
            <option value="">— الطبيب الذي يسجّل —</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
      </div>

      <label className="mb-2 block">
        <span className={label}>كيف عومل المال قبل النظام</span>
        <select value={financialMode} onChange={(event) => setFinancialMode(event.target.value as LegacyFinancialMode | "")}
          aria-label="النظام المالي السابق" className={field}>
          <option value="">— اختر —</option>
          {LEGACY_FINANCIAL_MODES.map((mode) => <option key={mode} value={mode}>{LEGACY_FINANCIAL_LABEL[mode]}</option>)}
        </select>
      </label>
      {financialMode ? (
        <p className="mb-2 rounded-lg bg-sky-50 px-2 py-1 text-[11px] text-sky-900">{LEGACY_FINANCIAL_HINT[financialMode]}</p>
      ) : null}

      <label className="mb-3 block">
        <span className={label}>الأهداف المتبقية</span>
        <textarea value={objectives} onChange={(event) => setObjectives(event.target.value)} rows={2}
          aria-label="الأهداف المتبقية" placeholder="إغلاق فراغ القلع العلوي، تصحيح الخط المتوسط…" className={field} />
      </label>

      <button type="submit" disabled={saving || form.draft.uncertain}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-xs font-black text-white disabled:opacity-50">
        {saving ? "جارٍ التسجيل…" : "سجّل الحالة السابقة"}
      </button>
    </form>
  );
}
