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
  pendingAssessments?: React.ComponentProps<typeof PatientOrtho>["pendingAssessments"];
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
  pendingAssessments,
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
  const [selectedOrthoCaseId, setSelectedOrthoCaseId] = useState<number | null>(
    context?.orthoCaseId ?? null,
  );
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
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

  const effectiveCaseId = context?.orthoCaseId ?? selectedOrthoCaseId;

  const liveCase = useMemo(
    () =>
      liveCases.find((c) => c.id === effectiveCaseId) ??
      liveCases.find((c) => c.status === "active" || c.status === "retention") ??
      liveCases[0] ??
      null,
    [liveCases, effectiveCaseId],
  );

  useEffect(() => {
    setActiveOrthoCorePatientId(patientId, liveCase?.id ?? null);
  }, [patientId, liveCase?.id]);

  const needsExtendedWorkspace = activeTab !== "sessions" || printState.open || aiDrawerOpen;

  const loadWorkspaceAndLiveContext = useCallback(async () => {
    if (!needsExtendedWorkspace || perms.loading) return;
    if (!perms.moduleVisible || !perms.can("records.read")) {
      setLoadingWorkspace(false);
      return;
    }
    setLoadingWorkspace(true);
    try {
      const canSeePhotos =
        session?.role !== "reception" &&
        perms.can("photos.view") &&
        perms.canField("previousPhotos");
      const [wsRes, orthoRes, docsRes] = await Promise.all([
        fetch(`/api/ortho/workspace/${patientId}`, { cache: "no-store" }),
        fetch(`/api/ortho?patientId=${patientId}`, { cache: "no-store" }),
        canSeePhotos
          ? fetch(`/api/patients/${patientId}/documents`, { cache: "no-store" })
          : Promise.resolve(null),
      ]);

      if (wsRes.ok) {
        const wsData = (await wsRes.json()) as { workspace?: OrthoWorkspaceRecord };
        if (wsData.workspace) {
          setRecord(wsData.workspace);
          latestRecordRef.current = wsData.workspace;
        }
      }

      if (orthoRes.ok) {
        const orthoData = (await orthoRes.json()) as { cases?: LiveOrthoCaseSummary[] };
        const casesList = Array.isArray(orthoData.cases) ? orthoData.cases : [];
        setLiveCases(casesList);
        setSelectedOrthoCaseId((prev) => {
          if (context?.orthoCaseId && casesList.some((c) => c.id === context.orthoCaseId)) {
            return context.orthoCaseId;
          }
          if (prev !== null && casesList.some((c) => c.id === prev)) {
            return prev;
          }
          const preferred =
            casesList.find((c) => c.status === "active" || c.status === "retention") ??
            casesList[0] ??
            null;
          return preferred?.id ?? null;
        });
      }

      if (docsRes && docsRes.ok) {
        const docsData = (await docsRes.json()) as { documents?: LivePatientDocument[] } | LivePatientDocument[];
        const list = Array.isArray(docsData)
          ? docsData
          : Array.isArray(docsData?.documents)
            ? docsData.documents
            : [];
        setLiveDocs(list);
      } else {
        setLiveDocs([]);
      }
    } finally {
      setLoadingWorkspace(false);
    }
  }, [needsExtendedWorkspace, patientId, perms.loading, perms.moduleVisible, perms.can, perms.canField, session?.role, context?.orthoCaseId]);

  useEffect(() => {
    void loadWorkspaceAndLiveContext();
  }, [loadWorkspaceAndLiveContext]);

  const persistWorkspace = async (next: OrthoWorkspaceRecord) => {
    setSavingState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`/api/ortho/workspace/${patientId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: next,
          expectedRevision: next.revision,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        workspace?: OrthoWorkspaceRecord;
        message?: string;
      } | null;
      if (!res.ok) {
        setSavingState("error");
        setSaveError(data?.message ?? "تعذّر حفظ بيانات وحدة التقويم.");
        return;
      }
      if (data?.workspace) {
        setRecord(data.workspace);
        latestRecordRef.current = data.workspace;
      }
      setSavingState("saved");
    } catch {
      setSavingState("error");
      setSaveError("تعذّر الاتصال بالخادم لحفظ ملف التقويم.");
    }
  };

  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
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
    () => buildPreviousCasesMedia(liveDocs, liveCase?.id ?? null, canViewPhotos),
    [liveDocs, liveCase?.id, canViewPhotos],
  );

  const latestCaseRef = useRef<PatientCase>(orthoCoreDraft);
  useEffect(() => {
    latestCaseRef.current = orthoCoreDraft;
  }, [orthoCoreDraft]);

  const handleOrthoCoreUpdate = useCallback(
    (nextCase: PatientCase, timelineMsg?: { ar: string; en: string }) => {
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
        void persistWorkspace(latestRecordRef.current);
      }, 750);
    },
    [perms, lang, actorName, orthoRole, activeTab, persistWorkspace],
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

          {/* Case Selector Bar when patient has multiple orthodontic cases */}
          {!isBlindOnly && liveCases.length > 1 && activeTab !== "sessions" ? (
            <div
              data-testid="ortho-case-selector-bar"
              dir="rtl"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-navy-100 bg-slate-50 px-3 py-2 text-xs"
            >
              <span className="font-bold text-navy-900">
                فصل السجل والصور حسب الحالة التقويمية:
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {liveCases.map((c) => {
                  const isCurrentActive = c.status === "active" || c.status === "retention";
                  const isSelected = liveCase?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedOrthoCaseId(c.id)}
                      className={`rounded-lg border px-3 py-1 text-xs font-bold transition-colors ${
                        isSelected
                          ? "border-navy-900 bg-navy-900 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      {isCurrentActive ? `الحالة الحالية #${c.id}` : `حالة سابقة #${c.id}`}
                    </button>
                  );
                })}
              </div>
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
        {loadingWorkspace && activeTab !== "sessions" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
            جارٍ تحميل مساحة عمل التقويم…
          </div>
        ) : (
          <div>
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
                currentOrthoCaseId={liveCase?.id ?? null}
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
                pendingAssessments={pendingAssessments}
                context={context}
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
                patient={orthoCoreDraft}
                settings={clinicSettings}
                lang={lang}
                actorName={actorName}
                onChange={handleOrthoCoreUpdate}
                onOpenPrintView={(opts) => setPrintState({ open: true, ...opts })}
              />
            )}
          </div>
        )}
      </div>

      {/* Exact OrthoCore Print / PDF Summary View */}
      {!isBlindOnly && perms.can("reports.print") && perms.canSection("reports") ? (
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
