"use client";

import { assessCephCalculationReadiness } from "@/lib/ceph-calculation-readiness";
import { CephSavedCompletionEvidence } from "./CephSavedCompletionEvidence";
import { parseCephSourceIdentity, sameCephSourceIdentity, type CephCompletionSources } from "@/lib/ceph-source-review";
import { parseCephCorrectionOrigin, parseCephCorrectionSourceToken, sameCephCorrectionSource, type CephCorrectionSourceRead, type CephCorrectionOrigin } from "@/lib/ceph-correction-origin";
import type { CephProvenanceRead } from "@/lib/ceph-completion-provenance";
import { cephDocumentImageUrl, CEPH_IMAGE_UNAVAILABLE_NOTICE } from "@/lib/ceph-image-source";
import { normalizeCephDiagnosis, parseCephCompletionDiagnosis, type CephCompletionDiagnosis, type CephCompletionSnapshot } from "@/lib/ceph-completion-snapshot";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CephViewport, type CephImageSize } from "./CephViewport";
import { CephDraftReferenceEvidence } from "./CephDraftReferenceEvidence";
import { CephScientificContext } from "./CephScientificContext";
import { cephDraftReferenceContext, describeCephMeasurements, CEPH_UNAVAILABLE_NOTICE, CEPH_INTEGRITY_NOTICE, cephCompletionNotice, enrichPresentedCephMeasurements, isQuarantinedCephMeasurement, presentCephMeasurements } from "@/lib/cephPresentation";
import { fillEmptyCephDiagnosisFields } from "@/lib/ceph-diagnosis-fields";
import { CephEditQueue, type CephDraftEdit, type CephEditResult } from "@/lib/ceph-edit-queue";
import {
  CEPH_SCHOOLS, computeAll, LANDMARK_ORDER, landmarkDef, projectOnLine, REQUIRED_LANDMARKS, round1,
  isDescriptiveCephMeasurement,
  type EnrichedMeasurement, type CephSchool, type LandmarkCode, type LandmarkMap, type Pt,
} from "@/lib/ceph";

interface AnalysisProp {
  id: number;
  patientId: number;
  documentId: number;
  status: "draft" | "completed" | "discarded";
  orthoCaseId: number | null;
  phase: "pretreatment" | "during" | "posttreatment" | "followup";
  xrayDate: string | null;
  device: string | null;
  refSet: string;
  calibration: { x1: number; y1: number; x2: number; y2: number; mm: number } | null;
  mmPerPixel: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  correctionOrigin?: CephCorrectionOrigin | null;
  findings: { anb: number | null; fma: number | null; wits: number | null } | null;
}

interface LandmarkProp {
  code: LandmarkCode;
  x: number;
  y: number;
  source: "manual" | "suggested";
}

interface StampedMeasurement {
  code: string;
  value: number;
}

interface DiagnosisProp {
  skeletal: string | null;
  dental: string | null;
  softTissue: string | null;
  note: string | null;
  finalDx: string;
  createdBy: string;
  updatedAt: string;
}

const GUIDE_LINES: [LandmarkCode, LandmarkCode][] = [
  ["S", "N"], // الخط السهمي الأمامي
  ["Or", "Po"], // مستوى فرانكفورت
  ["Go", "Me"], // مستوى الفك السفلي
  ["N", "A"],
  ["N", "B"],
  ["N", "Pog"],
  ["A", "Pog"], // الخط الشفوي العظمي APog
  ["ANS", "PNS"], // مستوى الحنك
  ["OcclA", "OcclP"], // مستوى الإطباق
];

const PHASE_LABEL: Record<string, string> = {
  pretreatment: "قبل العلاج",
  during: "أثناء العلاج",
  posttreatment: "بعد العلاج",
  followup: "متابعة",
};

type LandmarkSources = Record<string, "manual" | "suggested">;
interface TraceSnapshot { points: LandmarkMap; sources: LandmarkSources }

interface DxState {
  skeletal: string;
  dental: string;
  softTissue: string;
  note: string;
  finalDx: string;
}

export function CephTracer({
  patientName,
  patientBirthYear,
  analysis,
  initialLandmarks,
  stamped,
  refValues,
  diagnosis: suppliedDiagnosis,
  provenance,
  completionSources,
  correctionSource,
  readOnly = false,
  actorId,
}: {
  patientName: string;
  patientBirthYear: number | null;
  analysis: AnalysisProp;
  initialLandmarks: LandmarkProp[];
  stamped: StampedMeasurement[] | null;
  refValues: Record<string, { mean: number; sd: number }> | null;
  refSetName: string | null;
  diagnosis: DiagnosisProp | null;
  provenance?: CephProvenanceRead;
  completionSources?: CephCompletionSources;
  correctionSource?: CephCorrectionSourceRead;
  /** Server-resolved UI capability; API authorization remains authoritative. */
  readOnly?: boolean;
  /** Immutable identity supplied by the authorized server workspace. */
  actorId?: number;
}) {
  const completed = analysis.status === "completed";
  const ancestry = parseCephCorrectionOrigin(analysis.correctionOrigin);
  // A correction is bound to the completed source actually opened here. A later
  // server bundle must never silently replace the command's reviewed identity.
  const [viewedCorrection] = useState(() => correctionSource?.state === "available"
    ? { token: parseCephCorrectionSourceToken(correctionSource.token), origin: parseCephCorrectionOrigin(correctionSource.origin) } : null);
  const correctionToken = viewedCorrection?.token;
  const correctionOrigin = viewedCorrection?.origin;
  const correctionReady = !!correctionToken && !!correctionOrigin
    && correctionToken.analysisId === analysis.id && correctionToken.patientId === analysis.patientId
    && correctionToken.orthoCaseId === analysis.orthoCaseId && correctionToken.documentId === analysis.documentId
    && correctionOrigin.parentAnalysisId === correctionToken.analysisId
    && correctionOrigin.recordedPatientId === correctionToken.patientId
    && correctionOrigin.orthoCaseId === correctionToken.orthoCaseId && correctionOrigin.documentId === correctionToken.documentId
    && correctionOrigin.sourceSnapshotSha256 === correctionToken.sourceSha256
    && correctionSource?.state === "available" && sameCephCorrectionSource(correctionToken, correctionSource.token)
    && JSON.stringify(correctionOrigin) === JSON.stringify(parseCephCorrectionOrigin(correctionSource.origin));
  // Keep the source identity and reference catalog from this mounted review.
  // A changed server bundle requires reopening, never an invisible submit refresh.
  const [viewedSources] = useState<CephCompletionSources | undefined>(() => completionSources
    ? JSON.parse(JSON.stringify(completionSources)) : undefined);
  const viewedIdentity = viewedSources?.state === "available" ? parseCephSourceIdentity(viewedSources.identity) : null;
  const draftReference = useMemo(() => cephDraftReferenceContext(viewedSources, { documentId: analysis.documentId, refSet: analysis.refSet }), [viewedSources, analysis.documentId, analysis.refSet]);
  const currentReference = cephDraftReferenceContext(completionSources, analysis);
  const sourcesReady = !!draftReference.identity && !!currentReference.identity
    && sameCephSourceIdentity(draftReference.identity, currentReference.identity)
    && JSON.stringify(draftReference.referenceSet) === JSON.stringify(currentReference.referenceSet);
  const historical = completed && provenance?.state === "versioned" ? provenance.witness : null;
  const imageSrc = completed && provenance?.state === "versioned"
    ? historical?.image?.documentId === analysis.documentId
      ? cephDocumentImageUrl(analysis.documentId, historical.image) : null
    : cephDocumentImageUrl(analysis.documentId, viewedIdentity ? { sha256: viewedIdentity.imageSha256 } : null);
  const diagnosis = historical ? (historical.snapshot.diagnosis ? { ...historical.snapshot.diagnosis,
    createdBy: "", updatedAt: historical.sealedAt } : null) : suppliedDiagnosis;
  const displayedRefName = completed ? historical?.referenceSet.name ?? "المرجع التاريخي غير موثّق" : draftReference.name;
  const [completing, setCompleting] = useState(false);
  const editScope = JSON.stringify([actorId ?? null, analysis.id, analysis.patientId, analysis.documentId,
    analysis.status, readOnly, completionSources, initialLandmarks, analysis.calibration, analysis.mmPerPixel]);
  const [initialEdit] = useState(() => ({ scope: editScope, analysisId: analysis.id,
    landmarks: initialLandmarks.map(point => ({ ...point })),
    calibration: analysis.calibration ? { ...analysis.calibration } : null, mmPerPixel: analysis.mmPerPixel }));
  const editedMount = useRef(false);
  const retiredMount = useRef(false);
  const [editReady, setEditReady] = useState(false);
  const [editRetired, setEditRetired] = useState(false);
  // Render identities are immutable. Queue/request state is published only at
  // commit and accessed by callbacks that still own that exact identity.
  const owner = useMemo(() => ({ scope: editScope }), [editScope]);
  const editRuntime = useRef<{ owner: typeof owner | null; active: boolean; queue: CephEditQueue | null }>({ owner: null, active: false, queue: null });
  const locked = completed || readOnly || completing;
  // Lifecycle reads/actions exist for completed studies too; the drawing queue
  // owner is intentionally inactive there and cannot own these requests.
  const viewScope = JSON.stringify([editScope, provenance, correctionSource]);
  const [initialViewScope] = useState(viewScope);
  const viewOwner = useMemo(() => ({ scope: viewScope }), [viewScope]);
  const viewRuntime = useRef<{ owner: typeof viewOwner | null; active: boolean; sent: boolean; retired: boolean; request: object | null }>({ owner: null, active: false, sent: false, retired: false, request: null });
  const [directRetired, setDirectRetired] = useState(false);
  useLayoutEffect(() => {
    viewRuntime.current.owner = viewOwner;
    if (viewRuntime.current.retired || viewOwner.scope !== initialViewScope) { setDirectRetired(true); return; }
    viewRuntime.current.active = true;
    return () => { viewRuntime.current.active = false; viewRuntime.current.request = null; if (viewRuntime.current.sent) viewRuntime.current.retired = true; };
  }, [viewOwner, initialViewScope]);
  const beginDirectRequest = () => {
    if (!(viewRuntime.current.owner === viewOwner && viewRuntime.current.active) || viewRuntime.current.request || directRetired) return null;
    const ticket = {}; viewRuntime.current.request = ticket; return ticket;
  };
  const currentDirectRequest = (ticket: object) => (viewRuntime.current.owner === viewOwner && viewRuntime.current.active) && viewRuntime.current.request === ticket;
  const finishDirectRequest = (ticket: object, completion = false) => {
    if (!currentDirectRequest(ticket)) return;
    viewRuntime.current.request = null; setSaving(false); if (completion) setCompleting(false);
  };

  const [points, setPointsState] = useState<LandmarkMap>(() => {
    const map: LandmarkMap = {};
    for (const lm of initialLandmarks) map[lm.code] = { x: lm.x, y: lm.y };
    return map;
  });
  const [sources, setSourcesState] = useState<LandmarkSources>(() => {
    const map: Record<string, "manual" | "suggested"> = {};
    for (const lm of initialLandmarks) map[lm.code] = lm.source;
    return map;
  });
  const sourcesRef = useRef(sources);
  const setSources = useCallback((update: LandmarkSources | ((current: LandmarkSources) => LandmarkSources)) => {
    const next = typeof update === "function" ? update(sourcesRef.current) : update;
    sourcesRef.current = next;
    setSourcesState(next);
  }, []);
  const [scale, setScale] = useState<number | null>(completed ? historical?.snapshot.mmPerPixel ?? null : analysis.mmPerPixel);
  const [calibration, setCalibration] = useState<AnalysisProp["calibration"]>(analysis.calibration);
  const [active, setActiveState] = useState<LandmarkCode | null>(null);
  const activeRef = useRef(active);
  const setActive = useCallback((next: LandmarkCode | null) => { activeRef.current = next; setActiveState(next); }, []);
  const [selected, setSelectedState] = useState<LandmarkCode | null>(null);
  const selectedRef = useRef(selected);
  const setSelected = useCallback((next: LandmarkCode | null) => { selectedRef.current = next; setSelectedState(next); }, []);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [calMode, setCalModeState] = useState<{ p1: Pt | null; p2: Pt | null } | null>(null);
  const calModeRef = useRef(calMode);
  const setCalMode = useCallback((next: typeof calMode) => { calModeRef.current = next; setCalModeState(next); }, []);
  const [calMm, setCalMmState] = useState("10");
  const calMmRef = useRef(calMm);
  const setCalMm = useCallback((next: string) => { calMmRef.current = next; setCalMmState(next); }, []);
  const calibrationInput = useMemo(() => ({ owner, calMode, calMm }), [owner, calMode, calMm]);
  const committedCalibrationInput = useRef<typeof calibrationInput | null>(null);
  const calibrationFlight = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedCalibrationInput.current = calibrationInput;
    return () => { if (committedCalibrationInput.current === calibrationInput) committedCalibrationInput.current = null; };
  }, [calibrationInput]);
  const [showGuides, setShowGuides] = useState(true);
  const [showFullTracing, setShowFullTracing] = useState(true);
  const [showLoupe, setShowLoupe] = useState(true);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [invert, setInvert] = useState(false);
  const [grayscale, setGrayscale] = useState(false);
  const [anonymize, setAnonymize] = useState(false);
  const [tracerStep, setTracerStep] = useState<"digitization" | "analysis" | "report">(
    completed ? "analysis" : "digitization"
  );
  const [analysisViewMode, setAnalysisViewMode] = useState<"table" | "chart">("table");
  const [hoveredPoint, setHoveredPoint] = useState<LandmarkCode | null>(null);
  const [selectedSchool, setSelectedSchool] = useState<CephSchool>("all");
  const [cursorSurfacePt, setCursorSurfacePt] = useState<Pt | null>(null);
  const [panMode, setPanModeState] = useState(false);
  const panModeRef = useRef(panMode);
  const setPanMode = useCallback((update: boolean | ((value: boolean) => boolean)) => {
    const next = typeof update === "function" ? update(panModeRef.current) : update;
    panModeRef.current = next; setPanModeState(next);
  }, []);
  const pointsRef = useRef(points);
  // Event handlers need the latest optimistic map before React renders. Keep the
  // ref and rendered state in the same event-side update, never mutate on render.
  const setPoints = useCallback((next: LandmarkMap) => {
    pointsRef.current = next;
    setPointsState(next);
  }, [setPointsState]);
  const suppressClick = useRef(false);
  const pointerClickPoint = useRef<Pt | null>(null);
  const dragStart = useRef<TraceSnapshot | null>(null);
  const onNaturalSize = useCallback((size: CephImageSize | null) => {
    setNatural((prev) => size && prev?.w === size.w && prev.h === size.h ? prev : size);
  }, [setNatural]);
  const [history, setHistoryState] = useState<TraceSnapshot[]>([]);
  const historyRef = useRef(history);
  const setHistory = useCallback((update: TraceSnapshot[] | ((current: TraceSnapshot[]) => TraceSnapshot[])) => {
    const next = typeof update === "function" ? update(historyRef.current) : update;
    historyRef.current = next; setHistoryState(next);
  }, []);
  const [future, setFutureState] = useState<TraceSnapshot[]>([]);
  const futureRef = useRef(future);
  const setFuture = useCallback((update: TraceSnapshot[] | ((current: TraceSnapshot[]) => TraceSnapshot[])) => {
    const next = typeof update === "function" ? update(futureRef.current) : update;
    futureRef.current = next; setFutureState(next);
  }, []);

  const imageFilterStyle = useMemo(() => {
    const f: string[] = [];
    if (brightness !== 100) f.push(`brightness(${brightness}%)`);
    if (contrast !== 100) f.push(`contrast(${contrast}%)`);
    if (invert) f.push("invert(100%)");
    if (grayscale) f.push("grayscale(100%)");
    return f.length > 0 ? f.join(" ") : "none";
  }, [brightness, contrast, invert, grayscale]);
  // One current draft calculation feeds both presentation and admission. Saved
  // completed history never enters today's engine or this readiness assessment.
  const results = useMemo(() => completed ? [] : computeAll(points, scale ?? NaN), [completed, points, scale]);
  const calculationReadiness = useMemo(() => completed ? null : assessCephCalculationReadiness(points, scale ?? NaN, results), [completed, points, scale, results]);
  const dragging = useRef<LandmarkCode | null>(null);
  const dragOwner = useRef<{ pointerId: number; owner: typeof owner; target: Element; code: LandmarkCode; clientX: number; clientY: number } | null>(null);
  const [draggingPoint, setDraggingPoint] = useState<LandmarkCode | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);
  const pendingWritesRef = useRef(0);
  const [saveFailure, setSaveFailure] = useState<Exclude<CephEditResult, { ok: true }> | null>(null);
  const allowDeparture = useRef(false);
  const currentFailure = useRef<typeof saveFailure>(null);
  const recoveryTicket = useMemo(() => ({ owner, viewOwner, failure: saveFailure }), [owner, viewOwner, saveFailure]);
  const committedRecovery = useRef<typeof recoveryTicket | null>(null);
  const consumedRecovery = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedRecovery.current = recoveryTicket;
    return () => { if (committedRecovery.current === recoveryTicket) committedRecovery.current = null; };
  }, [recoveryTicket]);
  const recoveryCurrent = () => (editRuntime.current.owner === owner && editRuntime.current.active) && (viewRuntime.current.owner === viewOwner && viewRuntime.current.active) && !viewRuntime.current.request
    && committedRecovery.current === recoveryTicket && consumedRecovery.current !== recoveryTicket
    && recoveryTicket.failure !== null && currentFailure.current === recoveryTicket.failure;
  const retryDrawingSave = () => {
    if (!recoveryCurrent() || recoveryTicket.failure?.conflict) return;
    consumedRecovery.current = recoveryTicket; currentFailure.current = null;
    setSaveFailure(null);
    editRuntime.current.queue?.retry();
  };
  const reloadDrawing = () => {
    if (!recoveryCurrent()) return;
    if (!window.confirm("ستُقرأ النسخة المحفوظة من الخادم. قد يكون الطلب السابق حُفظ رغم غياب التأكيد؛ التعديلات المحلية المعلّقة لن تُعاد تلقائيًا. هل تريد المتابعة؟")) return;
    if (!recoveryCurrent()) return;
    consumedRecovery.current = recoveryTicket; currentFailure.current = null;
    // Retire before navigation: a delayed/failed reload must never drain the old queue.
    editRuntime.current.active = false; editRuntime.current.queue?.retire(); editRuntime.current.queue = null;
    retiredMount.current = true;
    viewRuntime.current.active = false; viewRuntime.current.retired = true; viewRuntime.current.request = null;
    setEditReady(false); setEditRetired(true); setDirectRetired(true); setSaveFailure(null);
    allowDeparture.current = true;
    try { window.location.reload(); }
    catch {
      allowDeparture.current = false;
      setMessage("تعذّر إعادة تحميل الدراسة. انتهت جلسة التعديل؛ أعد فتح الدراسة للتحقق من المحفوظ. لم تُعَد إرسال الطلبات المعلّقة.");
    }
  };
  useLayoutEffect(() => {
    editRuntime.current.owner = owner;
    // Initial StrictMode replay has no user edits. A later reconnect must not
    // reconstruct CAS acknowledgement from stale initial props or replay writes.
    if (owner.scope !== initialEdit.scope) retiredMount.current = true;
    if (editedMount.current || retiredMount.current || readOnly || completed) {
      editRuntime.current.active = false;
      setEditReady(false);
      setEditRetired(true);
      return;
    }
    editRuntime.current.active = true;
    editRuntime.current.queue = new CephEditQueue(initialEdit.landmarks, async edit => {
      if (!(editRuntime.current.owner === owner && editRuntime.current.active)) return CephEditQueue.retiredResult;
      const response = await fetch(`/api/ceph/${initialEdit.analysisId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit),
      });
      const body = await response.json().catch(() => ({}));
      if (!(editRuntime.current.owner === owner && editRuntime.current.active)) return CephEditQueue.retiredResult;
      if (!response.ok) return { ok: false, conflict: response.status === 409,
        message: body.message ?? "تعذّر حفظ التعديلات. ما زالت على الشاشة فقط." };
      return { ok: true, mmPerPixel: body.mmPerPixel, calibration: body.calibration };
    }, (count, error) => { if ((editRuntime.current.owner === owner && editRuntime.current.active)) { currentFailure.current = error; pendingWritesRef.current = count; setPendingWrites(count); setSaveFailure(error); } },
    { calibration: initialEdit.calibration, mmPerPixel: initialEdit.mmPerPixel });
    setEditReady(true);
    return () => { editRuntime.current.active = false; editRuntime.current.queue?.retire(); editRuntime.current.queue = null; };
  }, [owner, initialEdit, readOnly, completed]);
  const enqueueEdit = useCallback((edit: CephDraftEdit) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || !editRuntime.current.queue) return Promise.resolve(CephEditQueue.retiredResult);
    editedMount.current = true;
    return editRuntime.current.queue.enqueue(edit);
  }, [owner]);
  const [dx, setDxState] = useState<DxState>(() => ({
    skeletal: diagnosis?.skeletal ?? "",
    dental: diagnosis?.dental ?? "",
    softTissue: diagnosis?.softTissue ?? "",
    note: diagnosis?.note ?? "",
    finalDx: diagnosis?.finalDx ?? "",
  }));
  const dxRef = useRef(dx);
  const setDx = useCallback((update: DxState | ((current: DxState) => DxState)) => {
    const next = typeof update === "function" ? update(dxRef.current) : update;
    dxRef.current = next;
    setDxState(next);
  }, []);
  const [acknowledgedDiagnosis, setAcknowledgedDiagnosis] = useState<CephCompletionDiagnosis | null>(() => diagnosis ? {
    skeletal: diagnosis.skeletal, dental: diagnosis.dental, softTissue: diagnosis.softTissue,
    note: diagnosis.note, finalDx: diagnosis.finalDx,
  } : null);
  const [dxDirty, setDxDirty] = useState(false);

  useEffect(() => {
    if (!pendingWrites && !dxDirty && !completing) return;
    const warn = (event: BeforeUnloadEvent) => { if (!allowDeparture.current) { event.preventDefault(); event.returnValue = ""; } };
    const blockLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      if (link.href === window.location.href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setMessage("انتظر حفظ التعديلات أو أعد محاولة الحفظ قبل مغادرة مساحة الرسم.");
    };
    // Modern browsers can also cancel same-document Back/Forward navigation.
    // beforeunload protects document departures in all supported browsers.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const blockNavigation = (event: Event) => {
      if (allowDeparture.current || (event as Event & { navigationType?: string }).navigationType === "reload") return;
      if (event.cancelable) {
        event.preventDefault();
        setMessage("توجد تعديلات غير محفوظة. احفظها قبل مغادرة مساحة الرسم.");
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", blockLink, true);
    navigation?.addEventListener("navigate", blockNavigation);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", blockLink, true);
      navigation?.removeEventListener("navigate", blockNavigation);
    };
  }, [pendingWrites, dxDirty, completing]);

  /** Manual edits, undo and calibration share an ordered, retryable queue. */
  const savePoint = useCallback((code: LandmarkCode, pt: Pt) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active)) return Promise.resolve(CephEditQueue.retiredResult);
    setSources((current) => ({ ...current, [code]: "manual" }));
    return enqueueEdit({ landmarks: [{ code, x: pt.x, y: pt.y, source: "manual" }] });
  }, [enqueueEdit, setSources, owner]);

  const pushHistory = useCallback((snap: LandmarkMap, snapSources: LandmarkSources = sourcesRef.current) => {
    setHistory((h) => [...h.slice(-39), { points: snap, sources: { ...snapSources } }]);
    setFuture([]);
  }, [setHistory, setFuture]);

  const placePoint = useCallback((code: LandmarkCode, pt: Pt) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked) return;
    const snapped = { x: round1(pt.x), y: round1(pt.y) };
    pushHistory(pointsRef.current);
    const next = { ...pointsRef.current, [code]: snapped };
    setPoints(next);
    setSelected(code);
    if (!locked) void savePoint(code, snapped);
  }, [locked, owner, pushHistory, savePoint, setPoints, setSelected]);

  /** Keep every clinical coordinate in native image pixels, at any fit/zoom/pan. */
  const imagePoint = (e: React.MouseEvent): Pt | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!natural || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(natural.w, ((e.clientX - rect.left) / rect.width) * natural.w)),
      y: Math.max(0, Math.min(natural.h, ((e.clientY - rect.top) / rect.height) * natural.h)),
    };
  };

  const surfaceContext = useRef<{ owner: typeof owner; locked: boolean; natural: typeof natural; calibrating: boolean; panMode: boolean } | null>(null);
  useLayoutEffect(() => {
    const context = { owner, locked, natural, calibrating: !!calMode, panMode };
    surfaceContext.current = context;
    return () => { if (surfaceContext.current === context) surfaceContext.current = null; };
  }, [owner, locked, natural, calMode, panMode]);
  const onSurfaceClick = (e: React.MouseEvent) => {
    const context = surfaceContext.current;
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || !(viewRuntime.current.owner === viewOwner && viewRuntime.current.active) || viewRuntime.current.request || !context || context.owner !== owner
      || context.locked || !natural || context.natural !== natural || context.calibrating !== !!calMode
      || context.panMode || panModeRef.current || !!calModeRef.current !== !!calMode || dragging.current) return;
    // Compatibility click events may round client coordinates to whole CSS
    // pixels. The preceding PointerEvent preserves subpixel native accuracy.
    const pt = e.detail > 0 ? pointerClickPoint.current ?? imagePoint(e) : imagePoint(e);
    pointerClickPoint.current = null;
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || !natural || panMode) return;
    if (!pt) return;
    if (calModeRef.current) {
      if (saving || calibrationFlight.current) return;
      if (!calModeRef.current.p1) { setCalMode({ p1: pt, p2: null }); return; }
      setCalMode({ p1: calModeRef.current.p1, p2: pt });
      return;
    }
    const code = activeRef.current ?? LANDMARK_ORDER.find((c) => pointsRef.current[c] == null) ?? null;
    if (!code) { setMessage("كل المعالم الإلزامية موضوعة — الإضافية تُختار من قائمتها."); return; }
    placePoint(code, pt);
    const remaining = LANDMARK_ORDER.filter((c) => c !== code && pointsRef.current[c] == null);
    setActive(remaining[0] ?? null);
  };

  const onPointerDown = (code: LandmarkCode) => (e: React.PointerEvent) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || calModeRef.current || panModeRef.current || dragging.current || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick.current = true;
    dragStart.current = { points: pointsRef.current, sources: { ...sourcesRef.current } };
    dragging.current = code;
    dragOwner.current = { pointerId: e.pointerId, owner, target: e.currentTarget as Element, code, clientX: e.clientX, clientY: e.clientY };
    setDraggingPoint(code);
    setSelected(code);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setCursorSurfacePt(pointsRef.current[code] ?? null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Viewing remains available without an edit queue (read-only/completed).
    // A held drag still requires its live edit owner and exact pointer.
    if (!(viewRuntime.current.owner === viewOwner && viewRuntime.current.active) || (dragging.current && (!(editRuntime.current.owner === owner && editRuntime.current.active) || dragOwner.current?.owner !== owner || dragOwner.current.pointerId !== e.pointerId))) return;
    const pt = imagePoint(e);
    if (!pt) return;
    setCursorSurfacePt(pt);
    const code = dragging.current;
    if (code && (editRuntime.current.owner === owner && editRuntime.current.active) && !locked) {
      const next = { ...pointsRef.current, [code]: { x: round1(pt.x), y: round1(pt.y) } };
      pointsRef.current = next;
      setPoints(next);
    } else {
      // Hit distance is measured in screen pixels, not affected by image resolution.
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = natural ? rect.width / natural.w : 1;
      let nearest: LandmarkCode | null = null, minD = 18;
      for (const [key, point] of Object.entries(points) as [LandmarkCode, Pt | undefined][]) {
        if (!point) continue;
        const distance = Math.hypot(point.x - pt.x, point.y - pt.y) * ratio;
        if (distance < minD) { minD = distance; nearest = key; }
      }
      setHoveredPoint(nearest);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || (dragging.current && (dragOwner.current?.owner !== owner || dragOwner.current.pointerId !== e.pointerId))) return;
    if (locked && dragging.current) { onPointerCancel(); return; }
    const release = imagePoint(e);
    const code = dragging.current;
    if (code && (!release || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY) || !Number.isFinite(release.x) || !Number.isFinite(release.y))) {
      onPointerCancel(e); return;
    }
    const started = dragOwner.current;
    pointerClickPoint.current = release;
    dragging.current = null;
    dragOwner.current = null;
    setDraggingPoint(null);
    if (code) {
      suppressClick.current = true;
      e.preventDefault();
      const before = dragStart.current;
      const original = before?.points[code];
      // Clicking within the hit circle is selection, not moving its center.
      const stationary = started?.clientX === e.clientX && started.clientY === e.clientY;
      const pt = stationary && original ? original : { x: round1(release!.x), y: round1(release!.y) };
      // Pointer-up can carry a newer native position than the last move event.
      setPoints({ ...pointsRef.current, [code]: pt });
      // Merely selecting a suggested point is not clinical review. Only an
      // actual coordinate change or the explicit per-point confirmation saves.
      if (pt && original && (pt.x !== original.x || pt.y !== original.y)) {
        pushHistory(before!.points, before!.sources);
        void savePoint(code, pt);
      }
    }
    dragStart.current = null;
    if (e.pointerType === "touch") setCursorSurfacePt(null);
  };

  const onPointerCancel = (event?: React.PointerEvent) => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || (event && (!dragOwner.current || dragOwner.current.owner !== owner || dragOwner.current.pointerId !== event.pointerId))) return;
    pointerClickPoint.current = null;
    dragging.current = null;
    dragOwner.current = null;
    setDraggingPoint(null);
    suppressClick.current = true;
    if (dragStart.current) {
      setPoints(dragStart.current.points);
      setSources(dragStart.current.sources);
    }
    dragStart.current = null;
    setCursorSurfacePt(null);
    setHoveredPoint(null);
  };

  const toggleCalibration = () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || saving || calibrationFlight.current) return;
    // A toolbar activation can interrupt a held landmark pointer. Restore its
    // unsaved preview and consume its trailing click before changing modes.
    // The viewport keeps ownership of any existing pan/pinch until it ends.
    onPointerCancel();
    if (calMode) { setCalMode(null); return; }
    setTracerStep("digitization");
    setPanMode(false);
    setCalMode({ p1: null, p2: null });
  };

  /** Arrow movement is saved in order, with no delayed timer able to undo Undo. */
  const nudge = useCallback((code: LandmarkCode, dxPx: number, dyPx: number) => {
    const current = pointsRef.current[code];
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || !current || locked || !natural || dragging.current || calMode || panMode || tracerStep !== "digitization") return;
    const pt = { x: round1(Math.max(0, Math.min(natural.w, current.x + dxPx))),
      y: round1(Math.max(0, Math.min(natural.h, current.y + dyPx))) };
    if (pt.x === current.x && pt.y === current.y) return;
    pushHistory(pointsRef.current);
    const next = { ...pointsRef.current, [code]: pt };
    pointsRef.current = next;
    setPoints(next);
    void savePoint(code, pt);
  }, [calMode, locked, natural, owner, panMode, pushHistory, savePoint, setPoints, tracerStep]);

  const persistDiff = useCallback((before: TraceSnapshot, after: TraceSnapshot) => {
    const codes = new Set([...Object.keys(before.points), ...Object.keys(after.points)]) as Set<LandmarkCode>;
    const landmarks: NonNullable<CephDraftEdit["landmarks"]> = [];
    const removeLandmarks: LandmarkCode[] = [];
    for (const code of codes) {
      const b = before.points[code], a = after.points[code];
      if (b?.x !== a?.x || b?.y !== a?.y || before.sources[code] !== after.sources[code]) {
        if (a) landmarks.push({ code, ...a, source: after.sources[code] ?? "suggested" });
        else if (b) removeLandmarks.push(code);
      }
    }
    if (landmarks.length || removeLandmarks.length) void enqueueEdit({ landmarks, removeLandmarks });
  }, [enqueueEdit]);

  const undo = useCallback(() => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || dragging.current || historyRef.current.length === 0) return;
    const prev = historyRef.current[historyRef.current.length - 1];
    const current = { points: pointsRef.current, sources: { ...sourcesRef.current } };
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [current, ...f].slice(0, 40));
    setPoints(prev.points);
    setSources(prev.sources);
    persistDiff(current, prev);
  }, [locked, owner, persistDiff, setFuture, setHistory, setPoints, setSources]);

  const redo = useCallback(() => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || dragging.current || futureRef.current.length === 0) return;
    const next = futureRef.current[0];
    const current = { points: pointsRef.current, sources: { ...sourcesRef.current } };
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h.slice(-39), current]);
    setPoints(next.points);
    setSources(next.sources);
    persistDiff(current, next);
  }, [locked, owner, persistDiff, setFuture, setHistory, setPoints, setSources]);

  const pointActionTicket = useMemo(() => ({ owner, selected, points, sources, locked, natural, saving, calMode, panMode, tracerStep }),
    [owner, selected, points, sources, locked, natural, saving, calMode, panMode, tracerStep]);
  const committedPointAction = useRef<typeof pointActionTicket | null>(null);
  const consumedPointAction = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedPointAction.current = pointActionTicket;
    return () => { if (committedPointAction.current === pointActionTicket) committedPointAction.current = null; };
  }, [pointActionTicket]);
  const canClearSelected = !locked && !!selected && !!points[selected] && !!natural && !saving
    && !pendingWrites && !saveFailure && !draggingPoint && !calMode && !panMode && tracerStep === "digitization";
  const currentPointAction = () => !locked && !!natural && !saving && (editRuntime.current.owner === owner && editRuntime.current.active) && (viewRuntime.current.owner === viewOwner && viewRuntime.current.active) && !viewRuntime.current.request
    && committedPointAction.current === pointActionTicket && consumedPointAction.current !== pointActionTicket
    && selectedRef.current === selected && pointsRef.current === points && sourcesRef.current === sources
    && !pendingWritesRef.current && !currentFailure.current && !dragging.current && !calModeRef.current
    && !panModeRef.current && !calibrationFlight.current;
  const clearSelectedPoint = () => {
    const current = () => canClearSelected && currentPointAction();
    if (!current() || !selected) return;
    const code = selected;
    if (!window.confirm(`إزالة موضع ${code} من هذه المسودة؟ سيصبح غير محدد، ويمكن استعادة الموضع ومصدره عبر التراجع. لا يعني ذلك غياب البنية التشريحية.`)) return;
    if (!current()) return;
    consumedPointAction.current = pointActionTicket;
    pushHistory(pointsRef.current, sourcesRef.current);
    const nextPoints = { ...pointsRef.current }, nextSources = { ...sourcesRef.current };
    delete nextPoints[code]; delete nextSources[code];
    setPoints(nextPoints); setSources(nextSources); setActive(code);
    void enqueueEdit({ removeLandmarks: [code] });
  };

  const reviewSelectedPoint = () => {
    const code = selected, pt = code ? pointsRef.current[code] : undefined;
    if (!currentPointAction() || !code || !pt || sourcesRef.current[code] !== "suggested") return;
    if (!window.confirm(`هل راجعت موضع ${code} (${landmarkDef(code).ar}) على الأشعة وتؤكد صحته؟ ستُسجّل المراجعة باسمك.`)) return;
    if (!currentPointAction() || sourcesRef.current[code] !== "suggested") return;
    consumedPointAction.current = pointActionTicket;
    pushHistory(pointsRef.current);
    void savePoint(code, pt);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (!selected || points[selected] == null) return;
      const step = e.shiftKey ? 10 : 1;
      const dxy: Record<string, [number, number]> = {
        ArrowUp: [0, -step], ArrowDown: [0, step],
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      };
      const d = dxy[e.key];
      if (!d) return;
      e.preventDefault();
      nudge(selected, d[0], d[1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, nudge, owner, points, redo, selected, undo]);

  const saveCalibration = async () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || !calMode?.p1 || !calMode?.p2 || saving || calibrationFlight.current
      || committedCalibrationInput.current !== calibrationInput || calModeRef.current !== calMode || calMmRef.current !== calMm) return;
    const mm = Number(calMm);
    if (!Number.isFinite(mm) || mm <= 0) { setMessage("أدخل المسافة الحقيقية بالمليمتر."); return; }
    const next = { x1: round1(calMode.p1.x), y1: round1(calMode.p1.y),
      x2: round1(calMode.p2.x), y2: round1(calMode.p2.y), mm };
    if (Math.hypot(next.x2 - next.x1, next.y2 - next.y1) < 0.1) {
      setMessage("اختر نقطتين مختلفتين للمعايرة."); return;
    }
    const flight = {}; calibrationFlight.current = flight;
    setSaving(true);
    try {
      const result = await enqueueEdit({ calibration: next });
      if (result.ok && (editRuntime.current.owner === owner && editRuntime.current.active) && calibrationFlight.current === flight) {
        setCalibration(result.calibration ?? next);
        // Read the authoritative scale from the same successful write, without a
        // second GET whose failure could leave new calibration with an old scale.
        setScale(result.mmPerPixel ?? null);
        if (committedCalibrationInput.current === calibrationInput && calModeRef.current === calMode && calMmRef.current === calMm) {
          setCalMode(null); setMessage("المعايرة محفوظة.");
        } else {
          setMessage("حُفظت المعايرة المرسلة؛ اختيار المسطرة الأحدث لم يُعتمد بعد.");
        }
      }
    } finally { if (calibrationFlight.current === flight) { calibrationFlight.current = null; if ((editRuntime.current.owner === owner && editRuntime.current.active)) setSaving(false); } }
  };

  const requiredMissing = REQUIRED_LANDMARKS.filter((c) => points[c] == null);
  const missing = LANDMARK_ORDER.filter((c) => points[c] == null);
  const unreviewed = LANDMARK_ORDER.filter((code) => points[code] != null && sources[code] !== "manual");
  const canComplete = calculationReadiness?.ready === true && owner.scope === initialEdit.scope && viewOwner.scope === initialViewScope && editReady && sourcesReady && !!natural && natural.w > 0 && natural.h > 0 && !locked && !calMode && draggingPoint === null && Number.isFinite(scale) && scale != null && scale > 0
    && requiredMissing.length === 0 && unreviewed.length === 0 && pendingWrites === 0 && !saveFailure && !dxDirty;
  const completionPct = Math.round(((REQUIRED_LANDMARKS.length - requiredMissing.length) / REQUIRED_LANDMARKS.length) * 100);
  const optionalMissing = LANDMARK_ORDER.filter((c) => points[c] == null && !REQUIRED_LANDMARKS.includes(c));

  // A retained button callback must not approve a newer draft using an older
  // readiness decision. Publish the ticket only for the committed render.
  const completionTicket = useMemo(() => ({ owner, points, sources, scale, calibration, acknowledgedDiagnosis, canComplete, saving }), [owner, points, sources, scale, calibration, acknowledgedDiagnosis, canComplete, saving]);
  const committedCompletionTicket = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedCompletionTicket.current = completionTicket;
    return () => { if (committedCompletionTicket.current === completionTicket) committedCompletionTicket.current = null; };
  }, [completionTicket]);

  const complete = async () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || committedCompletionTicket.current !== completionTicket || !canComplete || saving) return;
    const ticket = beginDirectRequest(); if (!ticket) return;
    if (!window.confirm("اعتماد التحليل يقفل التعديل ويختم القياسات والتشخيص. هل تريد الاعتماد؟")) { if (currentDirectRequest(ticket)) viewRuntime.current.request = null; return; }
    if (!currentDirectRequest(ticket) || !(editRuntime.current.owner === owner && editRuntime.current.active) || committedCompletionTicket.current !== completionTicket) { if (currentDirectRequest(ticket)) viewRuntime.current.request = null; return; }
    viewRuntime.current.sent = true;
    setCompleting(true);
    setSaving(true);
    try {
      const expectedSnapshot: CephCompletionSnapshot = {
        patientId: analysis.patientId, documentId: analysis.documentId, refSet: analysis.refSet,
        calibration, mmPerPixel: scale,
        landmarks: LANDMARK_ORDER.flatMap((code) => {
          const point = pointsRef.current[code];
          return point ? [{ code, ...point, source: sourcesRef.current[code] ?? "suggested" }] : [];
        }),
        diagnosis: acknowledgedDiagnosis,
      };
      const res = await fetch(`/api/ceph/${analysis.id}/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSnapshot, expectedSources: viewedIdentity }),
      });
      if (!currentDirectRequest(ticket)) return;
      const data = await res.json().catch(() => ({}));
      if (!currentDirectRequest(ticket)) return;
      if (res.ok) {
        allowDeparture.current = true;
        window.location.href = `/ceph/${analysis.id}`;
      } else {
        setMessage(data.message ?? "تعذّر الاعتماد.");
      }
    } catch {
      if (currentDirectRequest(ticket)) setMessage("تعذّر التحقق من نتيجة الاعتماد. قد يكون الطلب حُفظ؛ أعد فتح الدراسة للتحقق قبل تكراره.");
    } finally {
      finishDirectRequest(ticket, true);
    }
  };

  const duplicate = async () => {
    if (!completed || !correctionReady || !correctionToken) return;
    const ticket = beginDirectRequest(); if (!ticket) return;
    if (!window.confirm("فتح نسخة تصحيح عن هذا التحليل المعتمد؟")) { if (currentDirectRequest(ticket)) viewRuntime.current.request = null; return; }
    if (!currentDirectRequest(ticket)) return;
    viewRuntime.current.sent = true; setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, expectedCorrectionSource: correctionToken }) });
      if (!currentDirectRequest(ticket)) return;
      const data = await res.json().catch(() => ({}));
      if (!currentDirectRequest(ticket)) return;
      if (res.ok && Number.isSafeInteger(data.id) && data.id > 0) window.location.href = `/ceph/${data.id}`;
      else setMessage(res.ok ? "لم تتأكد هوية نسخة التصحيح. قد تكون حُفظت؛ أعد فتح سجل الدراسات للتحقق." : data.message ?? "تعذّر فتح النسخة.");
    } catch {
      if (currentDirectRequest(ticket)) setMessage("تعذّر التحقق من نتيجة فتح النسخة. قد تكون حُفظت؛ أعد فتح سجل الدراسات للتحقق قبل تكرار الطلب.");
    } finally { finishDirectRequest(ticket); }
  };

  const discard = async () => {
    if (completed || saving || pendingWrites > 0) return;
    const ticket = beginDirectRequest(); if (!ticket) return;
    const note = window.prompt("سبب رفض المسودة (يُوثَّق باسمك):");
    if (note === null) { if (currentDirectRequest(ticket)) viewRuntime.current.request = null; return; }
    if (!currentDirectRequest(ticket)) return;
    viewRuntime.current.sent = true; setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: note || "" }),
      });
      if (!currentDirectRequest(ticket)) return;
      const data = await res.json().catch(() => ({}));
      if (!currentDirectRequest(ticket)) return;
      if (res.ok) window.location.href = `/patients/${analysis.patientId}?tab=ceph`;
      else setMessage(data.message ?? "تعذّر الرفض.");
    } catch {
      if (currentDirectRequest(ticket)) setMessage("تعذّر التحقق من نتيجة رفض المسودة. قد يكون الطلب حُفظ؛ أعد فتح سجل الدراسات للتحقق.");
    } finally { finishDirectRequest(ticket); }
  };

  // Completed history uses saved provenance only, never today's interpretations.
  const table = useMemo(() => presentCephMeasurements(results, completed ? (stamped ?? []) : null, provenance),
    [completed, stamped, results, provenance]);

  const enriched = useMemo(() => enrichPresentedCephMeasurements(table, completed ? refValues : draftReference.refs, completed, draftReference.source), [table, refValues, draftReference, completed]);

  const summary = useMemo(() => (!completed ? describeCephMeasurements(table) : null), [table, completed]);

  const saveDiagnosis = async () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || saving) return;
    const submitted = dxRef.current;
    if (Object.values(submitted).some((value) => value.trim().length > 2000)) {
      setMessage("أحد حقول التشخيص يتجاوز 2000 حرف. اختصره قبل الحفظ؛ لم يُحذف نصك ولم يُرسل جزء منه.");
      return;
    }
    if (!submitted.finalDx.trim()) { setMessage("الاستنتاج السيفالومتري لا يُترك فارغًا — حرّره ثم احفظ."); return; }
    const ticket = beginDirectRequest(); if (!ticket) return;
    viewRuntime.current.sent = true;
    setSaving(true);
    try {
      const res = await fetch(`/api/ceph/${analysis.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnosis: submitted, expectedDiagnosis: acknowledgedDiagnosis }),
      });
      if (!currentDirectRequest(ticket)) return;
      const data = await res.json().catch(() => ({}));
      if (!currentDirectRequest(ticket)) return;
      if (res.ok) {
        const saved = parseCephCompletionDiagnosis(data.diagnosis);
        if (!saved || JSON.stringify(saved) !== JSON.stringify(normalizeCephDiagnosis(submitted))) {
          setMessage("لم تُؤكَّد النسخة المحفوظة من التشخيص. احتُفظ بتعديلاتك؛ أعد الحفظ قبل الاعتماد.");
          return;
        }
        setAcknowledgedDiagnosis(saved);
        // A response acknowledges only the submitted version. Text entered while
        // it was pending stays dirty and must not be overwritten or sealed.
        if (dxRef.current === submitted) {
          setDx({ skeletal: saved.skeletal ?? "", dental: saved.dental ?? "", softTissue: saved.softTissue ?? "",
            note: saved.note ?? "", finalDx: saved.finalDx });
          setDxDirty(false);
          setMessage("التشخيص محفوظ — سيمرّ مع الاعتماد كما كتبته.");
        } else {
          setMessage("حُفظت النسخة المرسلة؛ توجد تعديلات أحدث لم تُحفظ بعد.");
        }
      } else {
        setMessage(data.message ?? "تعذّر حفظ التشخيص.");
      }
    } catch {
      if (currentDirectRequest(ticket)) setMessage("تعذّر التحقق من حفظ التشخيص. احتُفظ بالنص؛ قد يكون الطلب حُفظ في الخادم.");
    } finally {
      finishDirectRequest(ticket);
    }
  };

  const discardDiagnosisEdits = () => {
    if (!dxDirty || saving || !window.confirm("تجاهل تعديلات التشخيص غير المحفوظة والعودة إلى آخر نسخة محفوظة؟")) return;
    setDx({ skeletal: acknowledgedDiagnosis?.skeletal ?? "", dental: acknowledgedDiagnosis?.dental ?? "",
      softTissue: acknowledgedDiagnosis?.softTissue ?? "", note: acknowledgedDiagnosis?.note ?? "",
      finalDx: acknowledgedDiagnosis?.finalDx ?? "" });
    setDxDirty(false);
    setMessage("أُلغيت التعديلات المحلية فقط؛ النسخة المحفوظة لم تتغير.");
  };

  const fillSuggestion = () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked || !table) return;
    const raw = describeCephMeasurements(table);
    setDx((prev) => fillEmptyCephDiagnosisFields(prev, raw));
    setDxDirty(true);
  };

  const generateDescriptiveObservations = () => {
    if (!(editRuntime.current.owner === owner && editRuntime.current.active) || locked) return;
    // Use the currently displayed measurements, including unsaved local edits.
    // No server round trip, external provider or stale response can overwrite notes.
    const raw = describeCephMeasurements(table);
    setDx((prev) => fillEmptyCephDiagnosisFields(prev, raw));
    setDxDirty(true);
    setMessage("تمت تعبئة الحقول الفارغة بقراءة وصفية للمراجعة؛ النصوص الموجودة وملاحظات الطبيب لم تتغير. لا تُحدَّد خطة العلاج آليًا، والحفظ منفصل.");
  };

  const nextToPlace = locked ? null : (active ?? missing[0] ?? null);
  const ageAtXray = analysis.xrayDate && patientBirthYear
    ? new Date(analysis.xrayDate).getUTCFullYear() - patientBirthYear
    : null;

  const visibleCalibration = calMode ?? (calibration ? { p1: { x: calibration.x1, y: calibration.y1 }, p2: { x: calibration.x2, y: calibration.y2 } } : null);

  // Reuse the exact native-coordinate scene in the main view and the loupe.
  const renderOverlay = (displayScale: number, interactive: boolean) => natural && <>
                  {/* الخطوط الاستدلالية الأساسية */}
                  {showGuides && GUIDE_LINES.map(([a, b]) => {
                    const pa = points[a];
                    const pb = points[b];
                    if (!pa || !pb) return null;
                    return (
                      <line
                        key={`guide-${a}${b}`}
                        x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                        stroke="rgba(37,99,235,0.45)" strokeWidth={Math.max(1, 1.2 / displayScale)}
                        strokeDasharray={`${6 / displayScale} ${4 / displayScale}`}
                      />
                    );
                  })}

                  {/* شبكة التخطيط الشعاعي والهيكل المتجهي الكامل (WebCeph Vector Tracing) */}
                  {showFullTracing && (
                    <g key="full-tracing-skeleton">
                      {/* مستويات الجمجمة الأساسية */}
                      {points.S && points.N && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.N.x} y2={points.N.y} stroke="#2563eb" strokeWidth={Math.max(1.8, 2.5 / displayScale)} />
                      )}
                      {points.Po && points.Or && (
                        <line x1={points.Po.x} y1={points.Po.y} x2={points.Or.x} y2={points.Or.y} stroke="#d97706" strokeWidth={Math.max(1.6, 2.2 / displayScale)} />
                      )}
                      {points.Go && points.Me && (
                        <line x1={points.Go.x} y1={points.Go.y} x2={points.Me.x} y2={points.Me.y} stroke="#059669" strokeWidth={Math.max(1.8, 2.5 / displayScale)} />
                      )}
                      {points.PNS && points.ANS && (
                        <line x1={points.PNS.x} y1={points.PNS.y} x2={points.ANS.x} y2={points.ANS.y} stroke="#0891b2" strokeWidth={Math.max(1.4, 1.8 / displayScale)} />
                      )}
                      {points.OcclP && points.OcclA && (
                        <line x1={points.OcclP.x} y1={points.OcclP.y} x2={points.OcclA.x} y2={points.OcclA.y} stroke="#7c3aed" strokeWidth={Math.max(1.5, 2 / displayScale)} />
                      )}

                      {/* الخطوط الهيكلية السهمية والمثلثات */}
                      {points.N && points.Pog && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.Pog.x} y2={points.Pog.y} stroke="#64748b" strokeWidth={Math.max(1, 1.4 / displayScale)} strokeDasharray={`${4 / displayScale} ${3 / displayScale}`} />
                      )}
                      {points.S && points.Gn && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Gn.x} y2={points.Gn.y} stroke="#8b5cf6" strokeWidth={Math.max(1, 1.4 / displayScale)} strokeDasharray={`${5 / displayScale} ${3 / displayScale}`} />
                      )}
                      {points.N && points.A && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.A.x} y2={points.A.y} stroke="#94a3b8" strokeWidth={Math.max(1, 1.2 / displayScale)} strokeDasharray={`${3 / displayScale} ${2 / displayScale}`} />
                      )}
                      {points.N && points.B && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.B.x} y2={points.B.y} stroke="#94a3b8" strokeWidth={Math.max(1, 1.2 / displayScale)} strokeDasharray={`${3 / displayScale} ${2 / displayScale}`} />
                      )}
                      {points.A && points.Pog && (
                        <line x1={points.A.x} y1={points.A.y} x2={points.Pog.x} y2={points.Pog.y} stroke="#f59e0b" strokeWidth={Math.max(1, 1.4 / displayScale)} strokeDasharray={`${4 / displayScale} ${2 / displayScale}`} />
                      )}

                      {/* مضلع بيورك وجاراك (Bjork-Jarabak Polygon: S-Ar and Ar-Go) */}
                      {points.S && points.Ar && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Ar.x} y2={points.Ar.y} stroke="#0284c7" strokeWidth={Math.max(1.5, 2 / displayScale)} />
                      )}
                      {points.Ar && points.Go && (
                        <line x1={points.Ar.x} y1={points.Ar.y} x2={points.Go.x} y2={points.Go.y} stroke="#0d9488" strokeWidth={Math.max(1.5, 2 / displayScale)} />
                      )}

                      {/* خطوط قاعدة الجمجمة مع Basion */}
                      {points.N && points.Ba && (
                        <line x1={points.N.x} y1={points.N.y} x2={points.Ba.x} y2={points.Ba.y} stroke="#0ea5e9" strokeWidth={Math.max(1.4, 1.8 / displayScale)} strokeDasharray={`${4 / displayScale} ${2 / displayScale}`} />
                      )}
                      {points.S && points.Ba && (
                        <line x1={points.S.x} y1={points.S.y} x2={points.Ba.x} y2={points.Ba.y} stroke="#0284c7" strokeWidth={Math.max(1.4, 1.8 / displayScale)} />
                      )}

                      {/* محاور القواطع العلوية والسفلية */}
                      {points.U1A && points.U1 && (
                        <line x1={points.U1A.x} y1={points.U1A.y} x2={points.U1.x} y2={points.U1.y} stroke="#a855f7" strokeWidth={Math.max(1.5, 2 / displayScale)} />
                      )}
                      {points.L1A && points.L1 && (
                        <line x1={points.L1A.x} y1={points.L1A.y} x2={points.L1.x} y2={points.L1.y} stroke="#c026d3" strokeWidth={Math.max(1.5, 2 / displayScale)} />
                      )}

                      {/* مساقط ويتس العمودية على خط الإطباق (Wits Perpendiculars) */}
                      {!completed && points.A && points.OcclA && points.OcclP && (() => {
                        const fa = projectOnLine(points.A, points.OcclA, points.OcclP);
                        if (![fa.x, fa.y].every(Number.isFinite)) return null;
                        return (
                          <line x1={points.A.x} y1={points.A.y} x2={fa.x} y2={fa.y} stroke="#ec4899" strokeWidth={Math.max(1, 1.5 / displayScale)} strokeDasharray={`${3 / displayScale} ${2 / displayScale}`} />
                        );
                      })()}
                      {!completed && points.B && points.OcclA && points.OcclP && (() => {
                        const fb = projectOnLine(points.B, points.OcclA, points.OcclP);
                        if (![fb.x, fb.y].every(Number.isFinite)) return null;
                        return (
                          <line x1={points.B.x} y1={points.B.y} x2={fb.x} y2={fb.y} stroke="#ec4899" strokeWidth={Math.max(1, 1.5 / displayScale)} strokeDasharray={`${3 / displayScale} ${2 / displayScale}`} />
                        );
                      })()}
                    </g>
                  )}

                  {/* خط ريكتس الجمالي E-Line من Prn إلى PogS */}
                  {points.Prn && points.PogS && (
                    <g key="eline-ricketts">
                      <line
                        x1={points.Prn.x} y1={points.Prn.y}
                        x2={points.PogS.x} y2={points.PogS.y}
                        stroke="#db2777" strokeWidth={Math.max(1.8, 2.4 / displayScale)}
                        strokeDasharray={`${6 / displayScale} ${3 / displayScale}`}
                      />
                      <text
                        x={(points.Prn.x + points.PogS.x) / 2 + 8 / displayScale}
                        y={(points.Prn.y + points.PogS.y) / 2}
                        fontSize={Math.max(9, 12 / displayScale)}
                        fill="#db2777"
                        fontWeight="bold"
                        className="pointer-events-none select-none"
                      >
                        E-Line (Ricketts)
                      </text>
                    </g>
                  )}

                  {/* شريط حجب هوية العينين للخصوصية الطبية (WebCeph Anonymization Mask) */}
                  {anonymize && (
                    <g key="anonymization-privacy-bar">
                      <rect
                        x={points.Or ? points.Or.x - 25 : (natural.w * 0.52)}
                        y={points.Or ? points.Or.y - 45 : (natural.h * 0.36)}
                        width={120}
                        height={40}
                        rx={Math.max(4, 6 / displayScale)}
                        fill="#09090b"
                        opacity="0.96"
                      />
                      <text
                        x={points.Or ? points.Or.x + 35 : (natural.w * 0.61)}
                        y={points.Or ? points.Or.y - 23 : (natural.h * 0.39)}
                        fill="#f8fafc"
                        fontSize={Math.max(8, 10 / displayScale)}
                        fontWeight="bold"
                        textAnchor="middle"
                        className="pointer-events-none select-none font-mono"
                      >
                        CONFIDENTIAL · سري
                      </text>
                    </g>
                  )}

                  {visibleCalibration?.p1 && visibleCalibration?.p2 && (
                    <line
                      x1={visibleCalibration.p1.x} y1={visibleCalibration.p1.y} x2={visibleCalibration.p2.x} y2={visibleCalibration.p2.y}
                      stroke="#b45309" strokeWidth={Math.max(1.5, 2 / displayScale)}
                    />
                  )}
                  {visibleCalibration?.p1 && !visibleCalibration.p2 && (
                    <circle cx={visibleCalibration.p1.x} cy={visibleCalibration.p1.y} r={Math.max(3, 5 / displayScale)} fill="#b45309" />
                  )}

                  {/* رسم المعالم التشريحية الـ 27 */}
                  {(Object.keys(points) as LandmarkCode[]).map((code) => {
                    const pt = points[code];
                    if (!pt) return null;
                    const isDragging = draggingPoint === code;
                    const isSuggested = sources[code] === "suggested";
                    const isHovered = hoveredPoint === code;
                    const pointFill = isDragging || isHovered
                      ? "#dc2626"
                      : isSuggested
                      ? "#9333ea"
                      : "#1e3a5f";
                    return (
                      <g
                        key={code}
                        onPointerEnter={interactive ? () => setHoveredPoint(code) : undefined}
                      >
                        {isSuggested && (
                          <circle
                            cx={pt.x} cy={pt.y}
                            r={Math.max(7, 12 / displayScale)}
                            fill="none"
                            stroke="#c084fc"
                            strokeWidth={Math.max(1.2, 1.8 / displayScale)}
                            strokeDasharray={`${3 / displayScale} ${2 / displayScale}`}
                          />
                        )}
                        <circle
                          cx={pt.x} cy={pt.y}
                          r={Math.max(isHovered ? 6 : 4, (isHovered ? 10 : 7) / displayScale)}
                          fill={pointFill}
                          stroke="#ffffff"
                          strokeWidth={Math.max(1, 1.5 / displayScale)}
                          className={locked ? "" : calMode ? "cursor-crosshair" : "cursor-grab"}
                          onPointerDown={interactive ? onPointerDown(code) : undefined}
                          onLostPointerCapture={interactive ? (e) => {
                            const held = dragOwner.current;
                            if (held?.owner === owner && held.code === code && held.target === e.currentTarget
                              && held.pointerId === e.pointerId && !e.currentTarget.hasPointerCapture(e.pointerId)) onPointerCancel(e);
                          } : undefined}
                          onClick={(e) => {
                            // Calibration must bubble through the viewport's
                            // gesture guard and use the image surface bounds.
                            if (calMode) return;
                            e.stopPropagation(); suppressClick.current = false;
                          }}
                        />
                        <text
                          x={pt.x + 10 / displayScale} y={pt.y - 10 / displayScale}
                          fontSize={Math.max(10, 14 / displayScale)}
                          fill={isSuggested ? "#7e22ce" : "#1e3a5f"}
                          fontWeight={isSuggested || isHovered ? "bold" : "normal"}
                          className="pointer-events-none select-none"
                        >
                          {code}{isSuggested ? " ✦" : ""}
                        </text>
                      </g>
                    );
                  })}
  </>;

  const renderMeasurementTable = (rows: EnrichedMeasurement[]) => <table className="w-full text-xs">
    <thead><tr className="border-b border-slate-100 text-slate-500">
      <th className="p-1 text-right">القياس</th><th className="p-1 text-left">القيمة</th>
      <th className="p-1 text-left">{completed ? "أرقام المرجع المحفوظة" : "أرقام الكتالوج فقط"}</th>
      <th className="p-1 text-right">مصدر الأرقام وحدودها</th>
    </tr></thead>
    <tbody>{rows.map(row => <tr key={row.code} className="border-b border-slate-100">
      <td className="p-1" title={row.ar}><span className="font-semibold">{row.code}</span><span className="block text-[10px] text-slate-500">{row.ar.split("—")[0].trim()}</span></td>
      <td className="p-1 text-left font-mono">{row.value ?? "—"}{row.value !== null ? row.unit : ""}</td>
      <td className="p-1 text-left font-mono">{(completed ? row.descriptiveOnly : isDescriptiveCephMeasurement(row.code)) ? "وصفي · بلا تصنيف"
        : row.refMean !== null && row.refSd !== null ? `${row.refMean}±${row.refSd}` : "غير متاح"}</td>
      <td className="p-1 text-slate-500" title={row.note}>{row.source}{completed && row.note ? <span className="block">{row.note}</span> : null}</td>
    </tr>)}</tbody>
  </table>;

  if (completed && provenance?.state === "integrity_unavailable") {
    return <p role="alert" className="p-4 text-red-700">{CEPH_INTEGRITY_NOTICE}</p>;
  }
  if (!imageSrc) return <p role="alert" className="p-4 text-red-700">{CEPH_IMAGE_UNAVAILABLE_NOTICE}</p>;
  return (
    <div className="space-y-3">
      {completed && <p role="note" className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{cephCompletionNotice(provenance)}</p>}
      {((!completed && !readOnly && editRetired) || directRetired) && <p role="alert" className="rounded border border-amber-300 p-3 text-xs">انتهت جلسة الرسم أو تغير نطاقها. قد يكون الطلب الجاري حُفظ؛ أعد فتح الدراسة للتحقق. لم تُعَد إرسال التعديلات المعلّقة.</p>}
      {!completed && calculationReadiness && <section aria-label="جاهزية الحسابات قبل الاعتماد" className="space-y-2 rounded border border-slate-200 p-3 text-xs">
        <p>فحص قابلية الحساب فقط؛ ليس تشخيصًا أو تحققًا من صحة مواضع المعالم سريريًا. تبقى مراجعة المعالم والمصادر والحفظ والمعايرة شروطًا مستقلة.</p>
        {!calculationReadiness.calibrationValid && <p role="status">المعايرة الصالحة لازمة للاعتماد؛ إمكان حساب بعض الزوايا لا يعفي منها.</p>}
        {!!calculationReadiness.missingRequired.length && <p>معالم إلزامية غير موضوعة: {calculationReadiness.missingRequired.join("، ")}</p>}
        {!!calculationReadiness.invalidLandmarks.length && <p role="alert">إحداثيات غير صالحة للحساب: {calculationReadiness.invalidLandmarks.join("، ")}</p>}
        {calculationReadiness.invalidResults && <p role="alert">تعذر مطابقة نواتج الحساب مع المدخلات الحالية؛ الاعتماد متوقف.</p>}
        {!!calculationReadiness.unavailable.length && <p role="alert">حسابات غير متاحة رغم وجود المعالم المطلوبة لها؛ راجع المدخلات والمعايرة. الاعتماد متوقف: <span dir="ltr">{calculationReadiness.unavailable.join(", ")}</span></p>}
        {!!calculationReadiness.optionalMissing.length && <details><summary>حسابات تنقصها معالم اختيارية؛ غيابها وحده لا يمنع الاعتماد</summary><ul>{calculationReadiness.optionalMissing.map(row => <li key={row.code}><span dir="ltr">{row.code}</span>: {row.landmarks.join("، ")}</li>)}</ul></details>}
        {calculationReadiness.ready && <p>الحسابات ذات المدخلات الموجودة قابلة للحساب؛ هذا لا يعني أن الاعتماد أو المراجعة السريرية اكتمل.</p>}
      </section>}
      {!completed && !sourcesReady && <p role="alert" className="rounded border border-amber-300 p-3 text-xs text-amber-900">مصادر الدراسة غير متاحة أو تغيرت منذ فتح هذه المراجعة. إن ظهرت أرقام مرجعية فهي من المصدر الذي فُتح سابقًا وليست تحديثًا للمصدر الحالي. أعد فتح الدراسة وراجعها؛ الاعتماد متوقف.</p>}
      {!completed && sourcesReady && !natural && <p role="note" className="text-xs text-amber-800">لا يمكن الاعتماد قبل تحميل صورة الأشعة المعروضة.</p>}
      {!completed && draftReference.identity && viewedIdentity && <details className="break-all text-xs text-slate-600"><summary>هوية مصادر هذه المراجعة</summary>
        <p>هذه هوية المستند وبصمته المسجلة، وليست إعادة حساب لبصمة بايتات الصورة في المتصفح أو تحققًا سريريًا.</p>
        <p dir="ltr">Document #{viewedIdentity.documentId} · {viewedIdentity.imageSha256}</p>
        <p dir="ltr">Reference {viewedIdentity.referenceSetKey} · {viewedIdentity.referenceSetSha256}</p>
        <p dir="ltr">Engine {viewedIdentity.engineVersion} · {viewedIdentity.engineSourceSha256}</p>
      </details>}
      {!completed && <CephDraftReferenceEvidence context={draftReference} />}
      {/* الشريط العلوي */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <Link href={`/patients/${analysis.patientId}?tab=ceph`} className="text-sm text-blue-700 hover:underline">
          ← ملف {patientName}
        </Link>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${completed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {completed ? `معتمد — ${analysis.completedBy ?? ""}` : "مسودة"}
        </span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
          {PHASE_LABEL[analysis.phase] ?? analysis.phase}
        </span>
        {analysis.xrayDate && (
          <span className="text-xs text-slate-500">
            الشععة: {analysis.xrayDate}{ageAtXray != null ? ` — العمر وقتها ≈ ${ageAtXray} سنة` : ""}
          </span>
        )}
        {displayedRefName && (
          <span className="text-xs text-slate-500" title="مجموعة القيم المرجعية المعروضة في الجدول">
            المرجع: {displayedRefName}
          </span>
        )}
        <span className="text-xs text-slate-500">
          المقياس: {completed && !historical ? "المعايرة التاريخية غير موثّقة" : scale != null ? `${(1 / scale).toFixed(1)} بكسل/مم` : "غير معايَر — القياسات الطولية معطّلة"}
        </span>
        <div className="grow" />
        {readOnly && <span className="text-xs text-slate-500">عرض فقط: تعديل القياسات والاعتماد يحتاجان صلاحية سريرية.</span>}
        {!locked && (
          <>
            <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
              title="الأداة السابقة قالب هندسي غير متحقق سريريًا؛ لا تكشف المعالم من صورة الأشعة. ضع المعالم يدويًا وراجعها.">
              التحديد التلقائي غير متاح؛ حدّد المعالم يدويًا
            </span>
            <button
              type="button"
              onClick={toggleCalibration}
              disabled={saving}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${calMode ? "border-amber-300 bg-amber-50 text-amber-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
            >
              {calMode ? "إلغاء المعايرة" : calibration ? "تصحيح المعايرة" : "معايرة الشععة"}
            </button>
            <button
              type="button"
              onClick={() => void complete()}
              disabled={!canComplete || saving}
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
              title={calMode ? "احفظ المعايرة الجديدة أو ألغِ اختيارها قبل الاعتماد" : draggingPoint !== null ? "أكمل تحريك المعلم واحفظه أولًا" : scale == null ? "المعايرة أولًا" : requiredMissing.length > 0 ? `ناقص: ${requiredMissing.join("، ")}`
                : unreviewed.length > 0 ? `تحتاج مراجعة فردية: ${unreviewed.join("، ")}` : dxDirty ? "احفظ التشخيص المعدّل قبل الاعتماد" : ""}
            >
              اعتماد التحليل
            </button>

          </>
        )}
        <Link
          href={`/print/ceph/${analysis.id}`}
          target="_blank"
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1 shadow-sm"
          title="طباعة التقرير السيفالومتري الرسمي A4 ثنائي اللغة"
        >
          <span>🖨️</span>
          <span>طباعة التقرير الرسمي</span>
        </Link>
        {!completed && (
            <button
              type="button"
              onClick={() => void discard()}
              disabled={saving || pendingWrites > 0}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              رفض المسودة
            </button>
        )}
        {completed && (
          <button
            type="button"
            onClick={() => void duplicate()}
            disabled={saving || directRetired || !correctionReady}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            نسخة تصحيح جديدة
          </button>
        )}
      </div>

      {ancestry && <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm">
        نسخة تصحيح مرتبطة بـ <Link className="underline" href={`/ceph/${ancestry.parentAnalysisId}`}>الدراسة <bdi>{ancestry.parentAnalysisId}</bdi></Link>.
        تبقى نتائج الدراسة السابقة محفوظة مستقلّة.
        {ancestry.parentCompletion.state === "unversioned" && " الاعتماد التاريخي السابق بلا شاهد مصدر محفوظ؛ هذا الربط لا يعيد اعتماده."}
      </p>}
      {completed && !correctionReady && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        تعذّر تثبيت مصدر نسخة التصحيح. أعد فتح الدراسة للتحقق قبل إنشاء نسخة جديدة.
      </p>}

      {/* شريط مسار العمل السيفالومتري كمنصة WebCeph (WebCeph 3-Stage Stepper) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-2.5 shadow-xs">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {/* الخطوة 1: الرسم والتحديد */}
          <button
            type="button"
            onClick={() => setTracerStep("digitization")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "digitization"
                ? "border-purple-600 bg-purple-50/90 text-purple-950 ring-2 ring-purple-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "digitization" ? "bg-purple-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                1
              </span>
              <div>
                <p className="text-xs font-black">1. تحديد المعالم والرسم</p>
                <p className="text-[10px] text-slate-500 font-mono">Digitization & Tracing</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-purple-700 bg-purple-100/80 px-2 py-0.5 rounded-full">
              {completionPct}%
            </span>
          </button>

          {/* الخطوة 2: التحليل والمدارس */}
          <button
            type="button"
            onClick={() => setTracerStep("analysis")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "analysis"
                ? "border-blue-600 bg-blue-50/90 text-blue-950 ring-2 ring-blue-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "analysis" ? "bg-blue-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                2
              </span>
              <div>
                <p className="text-xs font-black">2. التحليل والمدارس السبع</p>
                <p className="text-[10px] text-slate-500 font-mono">Ceph Analysis & Diagnosis</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-blue-700 bg-blue-100/80 px-2 py-0.5 rounded-full">
              49 قياساً
            </span>
          </button>

          {/* الخطوة 3: التقرير والمطابقة */}
          <button
            type="button"
            onClick={() => setTracerStep("report")}
            className={`flex items-center justify-between rounded-xl p-2.5 text-right transition-all border ${
              tracerStep === "report"
                ? "border-emerald-600 bg-emerald-50/90 text-emerald-950 ring-2 ring-emerald-500/20 shadow-xs"
                : "border-slate-200 bg-slate-50/60 text-slate-600 hover:bg-slate-100"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold ${
                tracerStep === "report" ? "bg-emerald-700 text-white shadow-xs" : "bg-white text-slate-700 border border-slate-200"
              }`}>
                3
              </span>
              <div>
                <p className="text-xs font-black">3. التقرير الرسمي والمطابقة</p>
                <p className="text-[10px] text-slate-500 font-mono">Superimposition & Report</p>
              </div>
            </div>
            <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-full">
              A4 جاهز
            </span>
          </button>
        </div>
      </div>

      {/* وضع المعايرة */}
      {calMode && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">
            المعايرة: انقر النقطة الأولى {calMode.p1 ? "ثم الثانية" : "على عنصرٍ معلوم طوله"}
            {calMode.p2 ? " — ثم أدخل المسافة الحقيقية" : ""}
          </p>
          <p className="mt-1 text-xs">
            كرة معايرة أو مسطرة مدمجة في الشععة. كل القياسات الطولية تُضرب في المقياس
            الناتج، والزوايا لا تحتاج المعايرة. <b>الاعتماد لا يمرّ بلا معايرة.</b>
          </p>
          {calMode.p1 && calMode.p2 && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={calMm}
                disabled={saving}
                onChange={(e) => { if ((editRuntime.current.owner === owner && editRuntime.current.active) && !calibrationFlight.current) setCalMm(e.target.value); }}
                className="w-28 rounded-lg border border-amber-300 px-2 py-1 text-sm"
              />
              <span className="text-xs">مم بين النقطتين</span>
              <button
                type="button"
                onClick={() => void saveCalibration()}
                disabled={saving}
                className="rounded-lg bg-amber-700 px-3 py-1 text-xs font-medium text-white"
              >
                حفظ المعايرة
              </button>
            </div>
          )}
        </div>
      )}

      {saveFailure && <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
        <p>{saveFailure.message}</p>
        <p>التعديلات المعلّقة دون تأكيد الحفظ: {pendingWrites}. قد يكون الطلب الجاري حُفظ؛ الاعتماد متوقف حتى يتأكد الحفظ.</p>
        {saveFailure.conflict ? <p>تغيّر التحليل في جلسة أخرى. أعد فتحه وراجع أحدث المعالم قبل إعادة التعديل.</p>
          : <button type="button" className="mt-2 rounded border px-3 py-1" onClick={retryDrawingSave}>إعادة محاولة الحفظ</button>}
        <button type="button" className="m-2 rounded border px-3 py-1" onClick={reloadDrawing}>إعادة تحميل أحدث نسخة</button>
      </div>}
      {message && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">{message}</p>
      )}

      {tracerStep === "report" ? (
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          {/* رأس التقرير والمطابقة */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-700 text-base text-white shadow-xs">
                  📑
                </span>
                <div>
                  <h3 className="text-sm font-black text-navy-900">
                    التقرير السيفالومتري الرسمي والمطابقة (Ceph Report & Superimposition)
                  </h3>
                  <p className="text-xs text-slate-500">
                    {completed ? "تقرير التحليل المحفوظ عند الاعتماد" : "مسودة للمراجعة؛ لم تُعتمد سريريًا بعد"}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/print/ceph/${analysis.id}`}
                target="_blank"
                className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-4 py-2 text-xs font-black text-white shadow hover:bg-navy-900 transition-colors"
              >
                <span>🖨️</span>
                <span>فتح وطباعة التقرير الرسمي A4</span>
              </Link>
              {!locked && (
                <button
                  type="button"
                  onClick={() => void complete()}
                  disabled={!canComplete || saving}
                  className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-black text-white shadow hover:bg-emerald-800 disabled:opacity-40 transition-colors"
                >
                  ✓ اعتماد التحليل النهائي
                </button>
              )}
            </div>
          </div>

          {/* بطاقات المؤشرات التشخيصية الرئيسية */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">العلاقة الفكية ANB</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "ANB")?.value != null ? `${enriched.find((r) => r.code === "ANB")?.value}${enriched.find((r) => r.code === "ANB")?.unit ?? ""}` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "ANB")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">زاوية المستوى الفكي FMA</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "FMA")?.value != null ? `${enriched.find((r) => r.code === "FMA")?.value}${enriched.find((r) => r.code === "FMA")?.unit ?? ""}` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "FMA")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">تقييم ويتس Wits</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "WITS")?.value != null ? `${enriched.find((r) => r.code === "WITS")?.value}${enriched.find((r) => r.code === "WITS")?.unit ?? ""}` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "WITS")?.interpretationAr ?? ""}
              </span>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-center">
              <span className="text-[11px] font-bold text-slate-500 block">بروفايل ريكتس (E-Line UL)</span>
              <span className="text-base font-black text-navy-900 font-mono" dir="ltr">
                {enriched.find((r) => r.code === "E_LINE_UL")?.value != null ? `${enriched.find((r) => r.code === "E_LINE_UL")?.value}${enriched.find((r) => r.code === "E_LINE_UL")?.unit ?? ""}` : "—"}
              </span>
              <span className="text-[10px] text-slate-600 block mt-0.5 font-medium">
                {enriched.find((r) => r.code === "E_LINE_UL")?.interpretationAr ?? ""}
              </span>
            </div>
          </div>

          {/* ملخص التشخيص المنظم وخطة العلاج */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <h4 className="text-xs font-black text-navy-900">{completed ? "التشخيص والملاحظات المحفوظة عند الاعتماد" : "مسودة التشخيص وملاحظات الطبيب"}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">التشخيص الهيكلي:</span>
                <p className="text-slate-800 font-medium">{dx.skeletal || "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">التشخيص السني:</span>
                <p className="text-slate-800 font-medium">{dx.dental || "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100">
                <span className="text-[10px] text-slate-500 font-bold block">الأنسجة الرخوة والبروفايل:</span>
                <p className="text-slate-800 font-medium">{dx.softTissue || "—"}</p>
              </div>
            </div>
            {dx.finalDx && (
              <div className="rounded-lg bg-blue-50/70 p-2.5 border border-blue-200 text-xs">
                <span className="text-[10px] text-blue-900 font-bold block">الاستنتاج السيفالومتري النهائي:</span>
                <p className="text-blue-950 font-bold">{dx.finalDx}</p>
              </div>
            )}
            {dx.note && (
              <div className="rounded-lg bg-slate-50 p-2.5 border border-slate-100 text-xs">
                <span className="text-[10px] text-slate-500 font-bold block">ملاحظات الطبيب وخطته:</span>
                <p className="text-slate-700 whitespace-pre-line">{dx.note}</p>
              </div>
            )}
          </div>

          {/* المطابقة السيفالومترية والمقارنة التطورية (Superimposition) */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-lg">📐</span>
              <h4 className="text-xs font-black text-indigo-950">
                المطابقة السيفالومترية التطورية (Cephalometric Superimposition)
              </h4>
            </div>
            <p className="text-xs text-indigo-900 leading-relaxed">
              المطابقة السيفالومترية في طب التقويم تجري وفق المرجعية العالمية على مستوى قاعدة الجمجمة <b>(S-N Plane)</b> متمركزة على نقطة السرج التركي <b>(Sella S)</b> لمقارنة التغيرات الهيكلية ونمو الفكين ومحاور الأسنان بين مرحلة ما قبل العلاج (T1) وأثناء العلاج (T2) وما بعد العلاج (T3).
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Link
                href={`/patients/${analysis.patientId}?tab=ceph`}
                className="rounded-lg bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-800 transition-colors"
              >
                استعراض مقارنة مراحل المريض الأخرى ←
              </Link>
              <button
                type="button"
                onClick={() => setTracerStep("analysis")}
                className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
              >
                ← العودة إلى التحليل والمدارس
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={`flex flex-col gap-3 ${tracerStep === "analysis" ? "2xl:flex-row" : ""}`}>
        {/* لوحة الرسم */}
        {completed && !historical && <p role="note" className="text-xs text-amber-800">المعالم والخطوط عرض هندسي للسجل القديم غير المتحقق؛ ليست تفسيرًا سريريًا أو قياسات معاد اعتمادها.</p>}
        <div className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">تكبير:</span>
            {[1, 2, 3, 4].map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                className={`rounded-md border px-2 py-0.5 ${zoom === z ? "border-navy-800 bg-navy-800 text-white" : "border-slate-300 text-slate-600"}`}
              >
                {z}×
              </button>
            ))}
            <button type="button" aria-pressed={panMode} onClick={() => { setPanMode((v) => !v); setCursorSurfacePt(null); }}
              className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600">
              {panMode ? "تحديد المعالم" : "تحريك الصورة"}
            </button>
            <label className="ms-3 flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
              الخطوط الاستدلالية
            </label>
            <label className="flex items-center gap-1 text-slate-600" title="عرض شبكة التخطيط الشعاعي والمستويات الهيكلية الكاملة كمنصة WebCeph">
              <input type="checkbox" checked={showFullTracing} onChange={(e) => setShowFullTracing(e.target.checked)} />
              شبكة التخطيط الكاملة
            </label>
            <label className="flex items-center gap-1 text-purple-700 font-medium" title="عدسة تكبير دائرية فائقة تظهر عند تحريك أو وضع المعالم">
              <input type="checkbox" checked={showLoupe} onChange={(e) => setShowLoupe(e.target.checked)} />
              🔍 عدسة التكبير (Loupe)
            </label>
            {!locked && (
              <>
                <button
                  type="button"
                  onClick={undo}
                  disabled={history.length === 0}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 disabled:opacity-40"
                  title="تراجع (Ctrl+Z)"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={future.length === 0}
                  className="rounded-md border border-slate-300 px-2 py-0.5 text-slate-600 disabled:opacity-40"
                  title="إعادة (Ctrl+Shift+Z)"
                >
                  إعادة
                </button>
              </>
            )}
            {(saving || pendingWrites > 0) && <span className="ms-2 text-slate-400">يحفظ… ({pendingWrites})</span>}
          </div>

          {/* شريط أدوات معالجة الصورة وتحسين التباين والخصوصية (WebCeph Image Filters & Privacy) */}
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200/80 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
            <span className="font-semibold text-slate-600 inline-flex items-center gap-1">
              <span>🎨</span>
              <span>فلاتر الرؤية:</span>
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500">سطوع:</span>
              <input
                type="range"
                min="50"
                max="180"
                step="5"
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-slate-300"
                title={`السطوع: ${brightness}%`}
              />
              <span className="w-7 font-mono text-[10px] text-slate-500">{brightness}%</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-500">تباين:</span>
              <input
                type="range"
                min="50"
                max="200"
                step="5"
                value={contrast}
                onChange={(e) => setContrast(Number(e.target.value))}
                className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-slate-300"
                title={`التباين: ${contrast}%`}
              />
              <span className="w-7 font-mono text-[10px] text-slate-500">{contrast}%</span>
            </div>
            <button
              type="button"
              onClick={() => setInvert((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                invert ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="عكس الألوان السلبي لإبراز حواف العظم والشوكية الأنفية"
            >
              🌓 سلبي (Negative)
            </button>
            <button
              type="button"
              onClick={() => setGrayscale((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                grayscale ? "border-slate-700 bg-slate-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title="تحويل إلى تدرج رمادي نقي لتقليل التشويش"
            >
              ⬛ رمادي
            </button>
            <button
              type="button"
              onClick={() => setAnonymize((v) => !v)}
              className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                anonymize ? "border-purple-700 bg-purple-700 text-white shadow-sm" : "border-purple-300 bg-white text-purple-700 hover:bg-purple-50"
              }`}
              title="وضع شريط خصوصية لحجب هوية المريض وعينيه لعرض الحالة أو التدريس (WebCeph Privacy Mode)"
            >
              🕶️ حجب العينين (Privacy)
            </button>
            {(brightness !== 100 || contrast !== 100 || invert || grayscale) && (
              <button
                type="button"
                onClick={() => {
                  setBrightness(100);
                  setContrast(100);
                  setInvert(false);
                  setGrayscale(false);
                }}
                className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700 hover:bg-rose-100"
                title="إعادة ضبط الصورة للافتراضي"
              >
                إعادة ضبط
              </button>
            )}
          </div>

          <CephViewport
            src={imageSrc} natural={natural} onNaturalSize={onNaturalSize}
            zoom={zoom} onZoomChange={setZoom} panMode={panMode} filter={imageFilterStyle}
            showLoupe={showLoupe} cursor={cursorSurfacePt} onCursor={setCursorSurfacePt}
            onClick={onSurfaceClick} onPointerStart={() => { suppressClick.current = false; pointerClickPoint.current = null; }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel} onGestureTakeover={() => onPointerCancel()} renderOverlay={renderOverlay}
          />
          {!locked && (
            <div className="mt-2 space-y-1">
              <p className="text-sm">
                <span className="text-slate-500">المعلم التالي: </span>
                {nextToPlace ? (
                  <>
                    <b>{landmarkDef(nextToPlace).ar}</b>
                    <span className="text-slate-500"> ({nextToPlace}) — {landmarkDef(nextToPlace).hint}</span>
                  </>
                ) : (
                  <span className="text-slate-500">كل الإلزامي موضوع — بقيت المعالم الاختيارية إن أردتها.</span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                اكتمال الإلزامي: {completionPct}٪ ({REQUIRED_LANDMARKS.length - requiredMissing.length}/{REQUIRED_LANDMARKS.length})
                {selected && points[selected] && " — الأسهم تحرّك النقطة المحددة (مع Shift أسرع)، Ctrl+Z تراجع."}
              </p>
            </div>
          )}
          {!locked && (
            <div className="mt-2 flex flex-wrap gap-1">
              {LANDMARK_ORDER.map((code) => {
                const isSuggested = sources[code] === "suggested";
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setActive(code);
                      setSelected(code);
                    }}
                    title={`${landmarkDef(code).hint}${landmarkDef(code).required ? "" : " (اختياري)"}${isSuggested ? " [مقترح قديم غير مراجع]" : ""}`}
                    className={`rounded-md border px-2 py-0.5 text-xs ${
                      points[code]
                        ? isSuggested
                          ? "border-purple-300 bg-purple-50 text-purple-800 font-medium"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                        : "border-dashed border-amber-300 bg-amber-50 text-amber-700"
                    } ${active === code || selected === code ? "ring-2 ring-navy-800" : ""}`}
                  >
                    {code}{points[code] ? (isSuggested ? " ✦" : " ✓") : ""}
                  </button>
                );
              })}
            </div>
          )}
          {!locked && selected && points[selected] && <button type="button" onClick={clearSelectedPoint}
            disabled={!canClearSelected} className="mt-2 rounded border px-3 py-2 text-sm disabled:opacity-40">
            إزالة موضع {selected} من المسودة
          </button>}
          {!locked && unreviewed.length > 0 && (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="ceph-review-required">
              <p>معالم تحتاج مراجعة فردية قبل الاعتماد: {unreviewed.length} ({unreviewed.join("، ")}).</p>
              <p className="mt-1 text-xs">اختر كل معلم وافحص موضعه على الأشعة. حرّكه لتصحيحه، أو أكّد مراجعته إذا كان موضعه صحيحًا. اختيار النقطة وحده لا يعتمدها.</p>
              {selected && points[selected] && sources[selected] === "suggested" && (
                <button type="button" onClick={reviewSelectedPoint}
                  disabled={!natural || pendingWrites > 0 || !!saveFailure || saving || draggingPoint !== null || !!calMode || panMode}
                  className="mt-2 rounded-lg border border-amber-700 bg-white px-3 py-1.5 font-medium disabled:opacity-40">
                  راجعت موضع {selected} على الأشعة
                </button>
              )}
            </div>
          )}
          {optionalMissing.length > 0 && !locked && (
            <p className="mt-1 text-xs text-slate-400">
              اختيارية لم توضع بعد: {optionalMissing.join("، ")} — تخدم تحاليل موسّعة (SND، McNamara، الحنكي).
            </p>
          )}

          {/* بطاقة الانتقال للمرحلة التالية (WebCeph Workflow Step 1 -> 2) */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-purple-200 bg-gradient-to-r from-purple-50 to-indigo-50/50 p-3 shadow-xs">
            <div>
              <p className="text-xs font-black text-purple-950">
                الخطوة التالية: التحليل السيفالومتري (WebCeph Analysis)
              </p>
              <p className="text-[11px] text-purple-800">
                بعد ضبط المعالم وتدقيقها بالعدسة المكبرة، انتقل لعرض تحاليل شتاينر، تويد، مكنمارا، ريكتس، كيم، ويتس.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTracerStep("analysis")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-purple-700 px-4 py-2 text-xs font-black text-white shadow hover:bg-purple-800 transition-all"
            >
              <span>عرض التحليل دون اعتماد المعالم</span>
              <span>←</span>
            </button>
          </div>
        </div>

        {/* جدول القياسات مع تبويبات كبار العلماء وأشرطة الانحراف البيانية (WebCeph Parity) */}
        <div className={`min-w-0 w-full ${tracerStep === "analysis" ? "2xl:w-[480px] 2xl:shrink-0" : ""}`}>
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <p role="note" className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{CEPH_UNAVAILABLE_NOTICE}</p>
            {!completed && <CephScientificContext />}
            {historical && <details className="break-all p-3 text-xs"><summary>مصادر الحساب والمراجع المحفوظة وقت الاعتماد</summary>
              <CephSavedCompletionEvidence witness={historical} />
              <p>{historical.referenceSet.name} · {historical.referenceSet.version}</p>
              <p dir="ltr">Image SHA-256: {historical.image.sha256}</p>
              <p dir="ltr">Reference SHA-256: {historical.referenceSetSha256}</p>
              {historical.measurements.map(row => <p key={row.code}>{row.code}: {row.algorithm.id} · {row.algorithm.version} · {row.algorithm.calculationVersion ?? "—"} · {row.reference.source}
                <span dir="ltr"> · SHA-256: {row.algorithm.sourceSha256}</span>
                {row.reference.sourceUrl && <span> · {row.reference.sourceUrl}</span>}
                {row.reference.populationReference && <span> · عينة وصفية محفوظة، ليست معيارًا شخصيًا: {row.reference.populationReference.mean} ± {row.reference.populationReference.sd} · {row.reference.populationReference.population}</span>}</p>)}
            </details>}
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 flex items-center justify-between text-sm font-medium text-slate-700">
              <span>{completed ? "القياسات المعتمدة — لقطة الاعتماد" : "القياسات السيفالومترية — حيّة مع كل نقطة"}</span>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setAnalysisViewMode("table")}
                    className={`rounded px-2.5 py-0.5 text-[11px] font-bold transition-all ${
                      analysisViewMode === "table" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:text-navy-900"
                    }`}
                  >
                    جدول
                  </button>
                  <button
                    type="button"
                    disabled={completed}
                    onClick={() => setAnalysisViewMode("chart")}
                    className={`rounded px-2.5 py-0.5 text-[11px] font-bold transition-all ${
                      analysisViewMode === "chart" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:text-navy-900"
                    }`}
                  >
                    مخطط
                  </button>
                </div>
                <span className="text-xs text-slate-400 font-mono">49 قياساً</span>
              </div>
            </div>

            {/* شريط تبويب كبار العلماء السبعة كمنصة WebCeph */}
            <div className="border-b border-slate-200 bg-slate-50/80 p-2">
              <div className="flex items-center gap-1 overflow-x-auto pb-1 text-xs">
                {CEPH_SCHOOLS.map((school) => {
                  const isSelected = selectedSchool === school.id;
                  const count = school.id === "all"
                    ? enriched.length
                    : enriched.filter((r) => r.schools.includes(school.id)).length;
                  return (
                    <button
                      key={school.id}
                      type="button"
                      onClick={() => setSelectedSchool(school.id)}
                      className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                        isSelected
                          ? "bg-navy-800 text-white shadow-sm"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                      title={school.descAr}
                    >
                      {school.nameAr}
                      <span className={`ms-1 rounded-full px-1.5 py-0.2 text-[10px] ${isSelected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selectedSchool !== "all" && (
                <div className="mt-1 rounded-md bg-white border border-slate-200/80 p-1.5 text-[11px] text-slate-600">
                  <span className="font-semibold text-slate-800">{CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.nameEn}</span>
                  <span className="text-slate-400 ms-1">({CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.author}): </span>
                  <span>{CEPH_SCHOOLS.find((s) => s.id === selectedSchool)?.descAr}</span>
                </div>
              )}
            </div>

            <div className="max-h-[50vh] overflow-auto p-2">
              {!completed && analysisViewMode === "chart" ? (
                <div className="space-y-2 p-1">
                  <p className="text-xs text-slate-600">عرض رقمي وصفي؛ لا تُرسم نطاقات طبيعية أو درجات شدة من كتالوج غير متحقق للمريض.</p>
                  {enriched.filter(row => !isQuarantinedCephMeasurement(row.code) && (selectedSchool === "all" || row.schools.includes(selectedSchool))).map(row => (
                    <div key={row.code} className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs">
                      <p><b>{row.code}</b> — {row.ar.split("—")[0]}</p>
                      <p className="font-mono">القيمة: {row.value ?? "—"}{row.value !== null ? row.unit : ""}</p>
                      <p>أرقام الكتالوج فقط: {isDescriptiveCephMeasurement(row.code) ? "وصفي · بلا تصنيف" : row.refMean !== null && row.refSd !== null ? `${row.refMean}±${row.refSd}` : "غير متاح"}</p>
                      <p className="text-slate-500">{row.source}</p>
                    </div>
                  ))}
                </div>
              ) : selectedSchool === "all" ? (
                (["sagittal", "vertical", "dental", "softTissue"] as const).map(group => {
                  const rows = enriched.filter(row => row.group === group);
                  return rows.length ? <div key={group} className="mb-3">
                    <p className="rounded bg-slate-50 p-2 text-xs text-slate-500">{group === "sagittal" ? "القياسات السهمية" : group === "vertical" ? "القياسات العمودية" : group === "dental" ? "قياسات الأسنان" : "قياسات الأنسجة الرخوة"}</p>
                    {renderMeasurementTable(rows)}
                  </div> : null;
                })
              ) : renderMeasurementTable(enriched.filter(row => row.schools.includes(selectedSchool)))}
            </div>
            {/* التشخيص المنظم: اقتراحُ النظام يُحرَّر ويوقَّع — المعتمد يُقرأ لا يُكتب. */}
            <div className="border-t border-slate-200 px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700">التشخيص السيفالومتري المنظم</p>
                {!locked && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={generateDescriptiveObservations}
                      className="rounded-md border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-40 inline-flex items-center gap-1"
                      title="قراءة وصفية محلية للقياسات في الحقول الفارغة فقط؛ لا تحدد خطة علاج"
                    >
                      <span>🧠</span>
                      <span>تعبئة قراءة وصفية</span>
                    </button>
                    <button
                      type="button"
                      onClick={fillSuggestion}
                      className="rounded-md border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
                      title="يملأ الحقول الفارغة فقط من القياسات؛ يحافظ على نصوص الطبيب"
                    >
                      تعبئة أساسية
                    </button>
                  </div>
                )}
              </div>
              {locked ? (
                acknowledgedDiagnosis ? (
                  <div className="space-y-1 text-xs text-slate-600">
                    {acknowledgedDiagnosis.skeletal && <p><b className="text-slate-500">هيكلي: </b>{acknowledgedDiagnosis.skeletal}</p>}
                    {acknowledgedDiagnosis.dental && <p><b className="text-slate-500">أسنان: </b>{acknowledgedDiagnosis.dental}</p>}
                    {acknowledgedDiagnosis.softTissue && <p><b className="text-slate-500">أنسجة رخوة: </b>{acknowledgedDiagnosis.softTissue}</p>}
                    <p><b className="text-slate-500">الاستنتاج: </b>{acknowledgedDiagnosis.finalDx}</p>
                    {acknowledgedDiagnosis.note && <p><b className="text-slate-500">ملاحظات: </b>{acknowledgedDiagnosis.note}</p>}
                    {completed && !historical && diagnosis && <p className="text-slate-400">حرّره {diagnosis.createdBy} — آخر تعديل {new Date(diagnosis.updatedAt).toLocaleDateString("ar")}</p>}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">لا يوجد تشخيص منظم محفوظ.</p>
                )
              ) : (
                <div className="space-y-2">
                  <p className="rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-500">
                    ما يكتبه النظام <b>قراءة وصفية أولية وليست تشخيصًا نهائيًا</b>. لا يحدد القلع أو التوسيع أو تعديل النمو أو الزرعات أو الجراحة. يبقى التشخيص والخطة مسؤولية الطبيب بعد الفحص.
                  </p>
                  <textarea
                    value={dx.skeletal}
                    onChange={(e) => { setDx({ ...dx, skeletal: e.target.value }); setDxDirty(true); }}
                    placeholder="هيكلي…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.dental}
                    onChange={(e) => { setDx({ ...dx, dental: e.target.value }); setDxDirty(true); }}
                    placeholder="أسنان…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.softTissue}
                    onChange={(e) => { setDx({ ...dx, softTissue: e.target.value }); setDxDirty(true); }}
                    placeholder="أنسجة رخوة…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.finalDx}
                    onChange={(e) => { setDx({ ...dx, finalDx: e.target.value }); setDxDirty(true); }}
                    placeholder="الاستنتاج السيفالومتري (مطلوب)…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-400 px-2 py-1 text-xs"
                  />
                  <textarea
                    value={dx.note}
                    onChange={(e) => { setDx({ ...dx, note: e.target.value }); setDxDirty(true); }}
                    placeholder="ملاحظات الطبيب (اختياري)…"
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void saveDiagnosis()}
                    disabled={saving || !dxDirty}
                    className="rounded-lg bg-navy-800 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                  >
                    حفظ التشخيص
                  </button>
                  <button type="button" onClick={discardDiagnosisEdits} disabled={saving || !dxDirty}
                    className="rounded-lg border border-slate-300 px-3 py-1 text-xs disabled:opacity-40">
                    إلغاء تعديلات التشخيص
                  </button>
                </div>
              )}
            </div>
            {summary && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                <p>{summary.skeletal}</p>
                <p className="mt-1 text-slate-400">
                  المرجع: {displayedRefName} · {draftReference.source} — أرقام مصدرية فقط، بلا تصنيف سريري.
                </p>
              </div>
            )}
            {completed && (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
                اعتمدها {analysis.completedBy} في {new Date(analysis.completedAt ?? "").toLocaleDateString("ar")}
                {analysis.note ? ` — ${analysis.note}` : ""}
              </div>
            )}

            {/* أزرار الانتقال المنهجي كمنصة WebCeph */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/90 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setTracerStep("digitization")}
                className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                ← العودة لتعديل المعالم والرسم
              </button>
              <button
                type="button"
                onClick={() => setTracerStep("report")}
                className="rounded-xl bg-emerald-700 px-4 py-1.5 text-xs font-black text-white shadow hover:bg-emerald-800 transition-colors inline-flex items-center gap-1"
              >
                <span>المتابعة للمطابقة والتقرير</span>
                <span>←</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
