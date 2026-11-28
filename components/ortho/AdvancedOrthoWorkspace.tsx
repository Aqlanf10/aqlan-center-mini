"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Printer, Save, ShieldAlert, Sparkles } from "lucide-react";
import { PatientOrtho } from "@/components/PatientOrtho";
import type { ClinicalNavigationContext } from "@/lib/patient-navigation";
import {
  ORTHO_WORKSPACE_TABS,
  createDefaultOrthoWorkspace,
  type OrthoWorkspaceRecord,
  type OrthoWorkspaceTabId,
} from "@/lib/ortho-workspace-types";
import { useOrthoPermissions } from "./useOrthoPermissions";
import { AqlanAiAssistantDrawer } from "./AqlanAiAssistantDrawer";
import { useSession } from "@/components/SessionProvider";
import { useClinicName } from "@/components/SettingsProvider";

// Exact OrthoCore UI & Clinical Studios (ported cleanly over AQLAN PostgreSQL & Auth)
import type { Language, PatientCase, UserRole } from "./orthocore/types/ortho";
import { STAGE_LABELS, tr } from "./orthocore/i18n/translations";
import { getCaseCompleteness } from "./orthocore/utils/orthoMath";
import { syncAutoProblems } from "./orthocore/utils/problemExtractor";
import { getPatientCurrentWires, inferOrthoPhase, ORTHO_PHASES } from "./orthocore/data/orthoCatalog";
import { setActiveOrthoCorePatientId } from "./orthocore/services/api";
import {
  applyOrthoCoreCaseToWorkspace,
  buildClinicSettingsForOrthoCore,
  buildOrthoCorePatientCase,
  buildPreviousCasesMedia,
  type LiveOrthoCaseSummary,
  type LivePatientDocument,
} from "./orthocore/utils/caseAdapter";
import { OverviewTab } from "./orthocore/components/tabs/OverviewTab";
import { QuestionnaireTab } from "./orthocore/components/tabs/QuestionnaireTab";
import { ExamTab } from "./orthocore/components/tabs/ExamTab";
import { MediaTab } from "./orthocore/components/tabs/MediaTab";
import { AnalysisTab } from "./orthocore/components/tabs/AnalysisTab";
import { DiagnosisTab } from "./orthocore/components/tabs/DiagnosisTab";
import { PlanTab } from "./orthocore/components/tabs/PlanTab";
import { RetentionTab } from "./orthocore/components/tabs/RetentionTab";
import { ReportsTab } from "./orthocore/components/tabs/ReportsTab";
import { PrintView } from "./orthocore/components/PrintView";

export interface AdvancedOrthoWorkspaceProps {
  patientId: number;
  patientName: string;
  patientCode: string;
  hasActiveOrthoCase: boolean;
  context?: ClinicalNavigationContext;
  onContextChange?: (context: ClinicalNavigationContext) => boolean | Promise<boolean>;
  onClinicalChange?: () => void;
  onNavigationGuardChange?: (guard: () => boolean) => () => void;
  onOpenTreatmentEntry?: () => void;
  onOpenAccount?: () => void;
}

function mapRoleForOrthoCore(role: string | undefined): UserRole {
  if (role === "admin") return "admin";
  if (role === "doctor") return "doctor";
  if (role === "assistant") return "assistant";
  return "reception";
}

export function AdvancedOrthoWorkspace({
  patientId,
  patientName,
  patientCode,
  context,
  onContextChange,
  onClinicalChange,
  onNavigationGuardChange,
  onOpenTreatmentEntry,
  onOpenAccount,
}: AdvancedOrthoWorkspaceProps) {
  const session = useSession();
  const clinicName = useClinicName() || "مركز الدكتور عقلان";
  const actorName = session?.displayName || session?.username || "الطبيب";
  const orthoRole = mapRoleForOrthoCore(session?.role);
  const perms = useOrthoPermissions({ enabled: true, patientId });
  const [lang, setLang] = useState<Language>("ar");

  const [activeTab, setActiveTab] = useState<OrthoWorkspaceTabId>(() => {
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search).get("orthoTab") as OrthoWorkspaceTabId | null;
      if (q && ORTHO_WORKSPACE_TABS.some((t) => t.id === q)) return q;
    }
    return "sessions";
  });

  const [record, setRecord] = useState<OrthoWorkspaceRecord>(() =>
    createDefaultOrthoWorkspace(patientId),
  );
  const [liveDocs, setLiveDocs] = useState<LivePatientDocument[]>([]);
  const [liveCases, setLiveCases] = useState<LiveOrthoCaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [workspaceReadError, setWorkspaceReadError] = useState<string | null>(null);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [printState, setPrintState] = useState<{
    open: boolean;
    anonymize?: boolean;
    excludeInternalNotes?: boolean;
    selectedMediaIds?: string[];
    customNarrativeTitle?: string;
    customNarrativeBody?: string;
  }>({ open: false });

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRecordRef = useRef<OrthoWorkspaceRecord>(record);
  const loadTicket = useRef(0);
  const saveInFlight = useRef(false);
  const [sendingWorkspace, setSendingWorkspace] = useState(false);

  const requestedCaseId = selectedCaseId ?? context?.orthoCaseId ?? null;
  const liveCase: LiveOrthoCaseSummary | null = useMemo(() => {
    if (requestedCaseId === 0) return null;
    if (requestedCaseId !== null) return liveCases.find(c => c.id === requestedCaseId) ?? null;
    return liveCases.find(c => c.status === "active") ?? liveCases[0] ?? null;
  }, [liveCases, requestedCaseId]);
  const workspaceMatchesCase = record.patientId === patientId && record.orthoCaseId === (liveCase?.id ?? null);

  useEffect(() => {
    setActiveOrthoCorePatientId(patientId, liveCase?.id ?? null);
  }, [patientId, liveCase?.id]);

  const needsExtendedWorkspace = activeTab !== "sessions" || printState.open || aiDrawerOpen;

  const loadWorkspaceAndLiveContext = useCallback(async () => {
    const ticket = ++loadTicket.current;
    if (!needsExtendedWorkspace || perms.loading) return;
    if (!perms.moduleVisible || !perms.can("records.read")) {
      setLoadingWorkspace(false);
      return;
    }
    if (autosaveTimer.current || saveInFlight.current) return;
    setLoadingWorkspace(true);
    setWorkspaceReadError(null);
    try {
      const canSeePhotos = session?.role !== "reception" && perms.can("photos.view") && perms.canField("previousPhotos");
      const [orthoRes, docsRes] = await Promise.all([
        fetch(`/api/ortho?patientId=${patientId}`, { cache: "no-store" }),
        canSeePhotos ? fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      if (loadTicket.current !== ticket) return;
      if (!orthoRes.ok) throw new Error("تعذّر تحميل حالات التقويم.");
      const orthoData = await orthoRes.json() as { cases?: LiveOrthoCaseSummary[] };
      const cases = Array.isArray(orthoData.cases) ? orthoData.cases : [];
      const selected = requestedCaseId === null
        ? cases.find(c => c.status === "active") ?? cases[0]
        : cases.find(c => c.id === requestedCaseId);
      if (requestedCaseId !== null && requestedCaseId !== 0 && !selected) throw new Error("حالة التقويم المطلوبة غير متاحة.");
      const scopedCaseId = selected?.id ?? null;
      const search = scopedCaseId === null ? "" : `?orthoCaseId=${scopedCaseId}`;
      const wsRes = await fetch(`/api/ortho/workspace/${patientId}${search}`, { cache: "no-store" });
      if (!wsRes.ok) throw new Error("تعذّر تحميل مساحة عمل هذه الحالة.");
      const wsData = await wsRes.json() as { workspace?: OrthoWorkspaceRecord };
      const ws = wsData.workspace;
      if (!ws || ws.patientId !== patientId || ws.orthoCaseId !== scopedCaseId) throw new Error("بيانات مساحة العمل لا تطابق الحالة المختارة.");
      const data = docsRes?.ok ? await docsRes.json() as { documents?: LivePatientDocument[] } | LivePatientDocument[] : [];
      if (loadTicket.current !== ticket) return;
      setLiveCases(cases);
      setLiveDocs(Array.isArray(data) ? data : Array.isArray(data.documents) ? data.documents : []);
      setRecord(ws);
      latestRecordRef.current = ws;
      setSavingState("idle");
      setSaveError(null);
    } catch (error) {
      if (loadTicket.current === ticket) setWorkspaceReadError(error instanceof Error ? error.message : "تعذّر تحميل بيانات التقويم.");
    } finally {
      if (loadTicket.current === ticket) setLoadingWorkspace(false);
    }
  }, [needsExtendedWorkspace, patientId, perms, requestedCaseId, session?.role]);

  useEffect(() => {
    void loadWorkspaceAndLiveContext();
    return () => { loadTicket.current++; };
  }, [loadWorkspaceAndLiveContext]);

  const persistWorkspace = useCallback(async (next: OrthoWorkspaceRecord) => {
    if (saveInFlight.current || next.patientId !== patientId) return;
    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
    saveInFlight.current = true;
    setSendingWorkspace(true);
    setSavingState("saving");
    setSaveError(null);
    const scope = next.orthoCaseId;
    const search = scope === null ? "" : `?orthoCaseId=${scope}`;
    try {
      const res = await fetch(`/api/ortho/workspace/${patientId}${search}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: next, expectedRevision: next.revision }),
      });
      const data = await res.json().catch(() => null) as { workspace?: OrthoWorkspaceRecord; message?: string } | null;
      if (!res.ok) throw new Error(data?.message ?? "تعذّر حفظ بيانات وحدة التقويم.");
      if (!data?.workspace || data.workspace.patientId !== patientId || data.workspace.orthoCaseId !== scope) {
        throw new Error("لا تتطابق نتيجة الحفظ مع الحالة المختارة.");
      }
      if (latestRecordRef.current.patientId !== patientId || latestRecordRef.current.orthoCaseId !== scope) return;
      setRecord(data.workspace);
      latestRecordRef.current = data.workspace;
      setSavingState("saved");
    } catch (error) {
      setSavingState("error");
      setSaveError(error instanceof Error ? error.message : "تعذّر الاتصال بالخادم لحفظ ملف التقويم.");
    } finally {
      saveInFlight.current = false;
      setSendingWorkspace(false);
    }
  }, [patientId]);

  useEffect(() => {
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, []);

  const canViewPhotos =
    session?.role !== "reception" &&
    perms.can("photos.view") &&
    perms.canField("previousPhotos");
  const clinicSettings = useMemo(() => buildClinicSettingsForOrthoCore(clinicName), [clinicName]);

  const orthoCoreDraft: PatientCase = useMemo(
    () =>
      buildOrthoCorePatientCase({
        patientId,
        patientName,
        patientCode,
        record,
        liveDocs,
        liveCase,
        canViewPhotos,
      }),
    [patientId, patientName, patientCode, record, liveDocs, liveCase, canViewPhotos],
  );

  const previousCasesMedia = useMemo(
    () =>
      buildPreviousCasesMedia({
        liveDocs,
        liveCases,
        activeCaseId: liveCase?.id ?? null,
        canViewPhotos,
      }),
    [liveDocs, liveCases, liveCase?.id, canViewPhotos],
  );

  const latestCaseRef = useRef<PatientCase>(orthoCoreDraft);
  useEffect(() => {
    latestCaseRef.current = orthoCoreDraft;
  }, [orthoCoreDraft]);

  const handleOrthoCoreUpdate = useCallback(
    (nextCase: PatientCase, timelineMsg?: { ar: string; en: string }) => {
      if (loadingWorkspace || workspaceReadError || !workspaceMatchesCase || saveInFlight.current) return;
      if (!perms.can("records.edit") && !perms.can("records.create")) return;

      let syncedNext = nextCase;
      if (
        nextCase.clinicalExam !== latestCaseRef.current.clinicalExam ||
        nextCase.analyses !== latestCaseRef.current.analyses ||
        nextCase.diagnosis !== latestCaseRef.current.diagnosis
      ) {
        const synced = syncAutoProblems(nextCase, lang);
        if (synced.changed) {
          syncedNext = {
            ...nextCase,
            problems: synced.nextProblems,
            dismissedAutoProblemIds: synced.nextDismissed,
          };
        }
      }

      const enriched: PatientCase = timelineMsg
        ? {
            ...syncedNext,
            timeline: [
              {
                id: `tl-${Date.now()}`,
                timestamp: new Date().toISOString(),
                actor: actorName,
                actorRole: orthoRole,
                category:
                  activeTab === "questionnaire"
                    ? "intake"
                    : activeTab === "media"
                      ? "media"
                      : activeTab === "analysis"
                        ? "analysis"
                        : activeTab === "diagnosis"
                          ? "diagnosis"
                          : activeTab === "plan"
                            ? "plan"
                            : activeTab === "sessions"
                              ? "session"
                              : activeTab === "retention"
                                ? "retention"
                                : "exam",
                summaryAr: timelineMsg.ar,
                summaryEn: timelineMsg.en,
              },
              ...(syncedNext.timeline ?? []),
            ],
          }
        : syncedNext;

      const updatedRecord = applyOrthoCoreCaseToWorkspace(latestRecordRef.current, enriched);
      setRecord(updatedRecord);
      latestRecordRef.current = updatedRecord;
      latestCaseRef.current = enriched;

      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      setSavingState("saving");
      autosaveTimer.current = setTimeout(() => {
        autosaveTimer.current = null;
        void persistWorkspace(updatedRecord);
      }, 750);
    },
    [perms, lang, actorName, orthoRole, activeTab, persistWorkspace, loadingWorkspace, workspaceReadError, workspaceMatchesCase],
  );

  const visibleTabs = useMemo(() => {
    if (perms.loading) {
      return ORTHO_WORKSPACE_TABS.filter((t) => t.id === "sessions");
    }
    if (!perms.moduleVisible) return [];
    if (!perms.can("records.read") && perms.can("records.blind_create")) {
      return ORTHO_WORKSPACE_TABS.filter((t) => t.id === "sessions");
    }
    return ORTHO_WORKSPACE_TABS.filter(
      (t) => perms.canSection(t.sectionKey) || (t.id === "sessions" && perms.can("records.read")),
    );
  }, [perms]);

  useEffect(() => {
    if (!perms.loading && visibleTabs.length > 0 && !visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [perms.loading, visibleTabs, activeTab]);

  if (perms.loading && activeTab !== "sessions") {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
        جارٍ التحقق من صلاحيات وحدة التقويم…
      </div>
    );
  }

  if (!perms.loading && !perms.moduleVisible) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-xs text-amber-900 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span>وحدة تقويم الأسنان مخفية لحسابك وفق إعدادات الخصوصية والصلاحيات المعتمدة من المالك.</span>
      </div>
    );
  }

  const completeness = getCaseCompleteness(orthoCoreDraft);
  const liveWires = {
    upper: liveCase?.upperWire || getPatientCurrentWires(orthoCoreDraft).upper,
    lower: liveCase?.lowerWire || getPatientCurrentWires(orthoCoreDraft).lower,
  };
  const livePhase = ORTHO_PHASES.find((p) => p.id === (liveCase?.phase || inferOrthoPhase(orthoCoreDraft)));
  const isBlindOnly = !perms.can("records.read") && perms.can("records.blind_create");
  const canEdit = perms.can("records.edit") || perms.can("records.create");

  return (
    <div className="space-y-5">
      <div className={printState.open ? "space-y-5 no-print" : "space-y-5"}>
        {/* Exact OrthoCore Unified Patient Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-5 space-y-4 no-print">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">{patientName}</h2>
                {patientCode ? (
                  <span className="text-xs font-mono tabular-nums text-slate-500">· {patientCode}</span>
                ) : null}
                {isBlindOnly ? (
                  <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-semibold text-[11px]">
                    وضع الإدخال دون استعراض السجل السابق
                  </span>
                ) : null}
              </div>

              {!isBlindOnly ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-navy-600 mt-1">
                  <span className="font-semibold text-brand-blue">
                    {lang === "ar" ? STAGE_LABELS[orthoCoreDraft.stage].ar : STAGE_LABELS[orthoCoreDraft.stage].en}
                  </span>
                  {livePhase ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="px-2 py-0.5 rounded bg-navy-100 text-navy-800 font-semibold text-[11px]">
                        {lang === "ar" ? livePhase.ar : livePhase.en}
                      </span>
                    </>
                  ) : null}
                  {(liveWires.upper || liveWires.lower) && perms.canSection("sessions") ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        className="font-mono px-2 py-0.5 rounded bg-accent-50 border border-accent-200 text-accent-900 text-[11px]"
                        dir="ltr"
                      >
                        U: {liveWires.upper || "—"} / L: {liveWires.lower || "—"}
                      </span>
                    </>
                  ) : null}
                  <span aria-hidden="true">·</span>
                  <span>{orthoCoreDraft.assignedDoctor}</span>
                  {completeness.missingCount > 0 && perms.canSection("exam") ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1 text-amber-800 font-medium">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                        <span>
                          {completeness.missingCount} {tr(lang, "سجلات ناقصة", "missing items")}
                        </span>
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* Exact OrthoCore Action Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              {!isBlindOnly && liveCases.length > 0 ? (
                <label className="inline-flex items-center gap-1.5 text-xs text-navy-700">
                  <span className="font-semibold">{tr(lang, "الحالة:", "Case:")}</span>
                  <select
                    data-testid="ortho-case-switcher"
                    value={liveCase?.id ?? 0}
                    disabled={loadingWorkspace || savingState === "saving" || savingState === "error"}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isInteger(v) && v >= 0 && !autosaveTimer.current && !saveInFlight.current && savingState !== "error") {
                        setLoadingWorkspace(true);
                        setSelectedCaseId(v);

                      }
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-navy-900"
                  >
                    <option value={0}>{tr(lang, "ملف التقويم غير المرتبط بحالة", "Unassigned orthodontic intake")}</option>
                    {liveCases.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.id} · {c.status === "active" ? tr(lang, "نشطة", "Active") : tr(lang, "سابقة", "Previous")}
                        {c.startDate ? ` (${c.startDate})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {!isBlindOnly ? (
                <span className="text-xs text-navy-500 font-mono">
                  {savingState === "saving"
                    ? tr(lang, "جاري الحفظ التلقائي...", "Autosaving...")
                    : savingState === "saved"
                      ? tr(lang, "تم الحفظ", "Saved")
                      : savingState === "error"
                        ? tr(lang, "تعذر الحفظ", "Save error")
                        : ""}
                </span>
              ) : null}

              <button
                type="button"
                onClick={() => setLang((prev) => (prev === "ar" ? "en" : "ar"))}
                className="px-2.5 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-navy-800 rounded-lg"
                title="تبديل لغة واجهة وحدة التقويم"
              >
                {lang === "ar" ? "EN" : "عربي"}
              </button>

              {perms.can("ai.use") && perms.canSection("ai_assistant") ? (
                <button
                  type="button"
                  onClick={() => setAiDrawerOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-navy-50 hover:bg-navy-100 text-navy-800 rounded-lg whitespace-nowrap shrink-0 border border-navy-200"
                >
                  <Sparkles className="w-3.5 h-3.5 text-brand-orange" />
                  <span>{tr(lang, "عقلان المساعد الذكي", "AQLAN AI Assistant")}</span>
                </button>
              ) : null}

              {!isBlindOnly && perms.can("reports.print") && perms.canSection("reports") ? (
                <button
                  type="button"
                  onClick={() => setPrintState({ open: true })}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-navy-900 hover:bg-navy-800 text-white rounded-lg whitespace-nowrap shrink-0"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>{tr(lang, "معاينة الطباعة / PDF", "Print Summary")}</span>
                </button>
              ) : null}

              {!isBlindOnly && canEdit ? (
                <button
                  type="button"
                  disabled={loadingWorkspace || Boolean(workspaceReadError) || !workspaceMatchesCase}
                  onClick={() => void persistWorkspace(latestRecordRef.current)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-brand-orange hover:bg-accent-600 text-white rounded-lg whitespace-nowrap shrink-0"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{tr(lang, "حفظ الآن", "Save Now")}</span>
                </button>
              ) : null}
            </div>
          </div>

          {saveError ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
              {saveError}
            </div>
          ) : null}

          {/* Exact OrthoCore 10 Interconnected Tabs */}
          <nav
            aria-label="أقسام وحدة تقويم الأسنان"
            className="flex flex-wrap items-center gap-1 pb-1 border-t border-navy-100 pt-3"
          >
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === t.id
                    ? "bg-navy-900 text-white"
                    : "text-navy-600 hover:bg-navy-50 hover:text-navy-900"
                }`}
              >
                {lang === "ar" ? t.ar : t.en}
              </button>
            ))}
          </nav>
        </div>

        {/* Active Tab Content */}
        {workspaceReadError && activeTab !== "sessions" ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            {workspaceReadError}{" "}
            <button type="button" className="underline" onClick={() => void loadWorkspaceAndLiveContext()}>إعادة المحاولة</button>
          </div>
        ) : (loadingWorkspace || !workspaceMatchesCase) && activeTab !== "sessions" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
            جارٍ تحميل مساحة عمل التقويم…
          </div>
        ) : (
          <fieldset disabled={sendingWorkspace && activeTab !== "sessions"} className="min-w-0">
            {activeTab === "overview" && perms.canSection("overview") && (
              <OverviewTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "questionnaire" && perms.canSection("medical_history") && (
              <QuestionnaireTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "exam" && perms.canSection("exam") && (
              <ExamTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "media" && perms.canSection("media") && (
              <MediaTab
                patient={orthoCoreDraft}
                settings={clinicSettings}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                activeCaseId={liveCase?.id ?? null}
                previousCasesMedia={previousCasesMedia}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "analysis" && perms.canSection("measurements") && (
              <AnalysisTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "diagnosis" && perms.canSection("diagnosis") && (
              <DiagnosisTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "plan" && perms.canSection("plan") && (
              <PlanTab
                patient={orthoCoreDraft}
                lang={lang}
                role={orthoRole}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {/* Tab 8: Native AQLAN Daily Tightening Workflow + Package 2 Live Camera + Follow-up Doctor */}
            {activeTab === "sessions" && (perms.loading || perms.canSection("sessions") || perms.can("records.read") || isBlindOnly) && (
              <PatientOrtho
                patientId={patientId}
                context={liveCase && requestedCaseId !== null ? { ...context, orthoCaseId: liveCase.id } : context}
                onContextChange={onContextChange}
                onClinicalChange={() => {
                  onClinicalChange?.();
                  if (needsExtendedWorkspace) void loadWorkspaceAndLiveContext();
                }}
                onNavigationGuardChange={onNavigationGuardChange}
                onOpenTreatmentEntry={onOpenTreatmentEntry}
                onOpenAccount={onOpenAccount}
              />
            )}

            {activeTab === "retention" && perms.canSection("retention") && (
              <RetentionTab
                patient={orthoCoreDraft}
                lang={lang}
                onChange={handleOrthoCoreUpdate}
              />
            )}

            {activeTab === "reports" && perms.canSection("reports") && (
              <ReportsTab
                key={liveCase?.id ?? "intake"}
                orthoCaseId={liveCase?.id ?? null}
                patient={orthoCoreDraft}
                settings={clinicSettings}
                lang={lang}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
                onOpenPrintView={(opts) => setPrintState({ open: true, ...opts })}
              />
            )}
          </fieldset>
        )}
      </div>

      {/* Exact OrthoCore Print / PDF Summary View */}
      {!isBlindOnly && !loadingWorkspace && !workspaceReadError && workspaceMatchesCase && perms.can("reports.print") && perms.canSection("reports") ? (
        <PrintView
          open={printState.open}
          patient={orthoCoreDraft}
          settings={clinicSettings}
          lang={lang}
          initialAnonymize={printState.anonymize}
          initialExcludeInternalNotes={printState.excludeInternalNotes}
          initialSelectedMediaIds={printState.selectedMediaIds}
          customNarrativeTitle={printState.customNarrativeTitle}
          customNarrativeBody={printState.customNarrativeBody}
          onClose={() => setPrintState({ open: false })}
        />
      ) : null}

      {/* Package 6: AQLAN AI Assistant — عقلان المساعد الذكي (Local Clinical Engine + Zero-PHI External Guard) */}
      {perms.can("ai.use") && perms.canSection("ai_assistant") ? (
        <AqlanAiAssistantDrawer
          open={aiDrawerOpen}
          onClose={() => setAiDrawerOpen(false)}
          patientId={patientId}
        />
      ) : null}
    </div>
  );
}
