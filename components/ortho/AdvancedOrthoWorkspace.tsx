"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Save, Sparkles, Presentation, ShieldAlert, CheckCircle2, AlertTriangle } from "lucide-react";
import { PatientOrtho } from "@/components/PatientOrtho";
import type { ClinicalNavigationContext } from "@/lib/patient-navigation";
import {
  ORTHO_WORKSPACE_TABS,
  computeOrthoWorkspaceCompleteness,
  createDefaultOrthoWorkspace,
  type OrthoWorkspaceRecord,
  type OrthoWorkspaceTabId,
} from "@/lib/ortho-workspace-types";
import { useOrthoPermissions } from "./useOrthoPermissions";
import {
  OrthoExamTab,
  OrthoOverviewTab,
  OrthoQuestionnaireTab,
} from "./OrthoOverviewAndIntakeTabs";
import { OrthoMediaAnd3DTab } from "./OrthoMediaAnd3DTab";
import {
  OrthoDiagnosisTab,
  OrthoPlanTab,
  OrthoRetentionTab,
} from "./OrthoDiagnosisPlanRetentionTabs";
import { OrthoScientificAnalysisTab } from "./OrthoScientificAnalysisTab";
import { useSession } from "@/components/SessionProvider";

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
  /** Optional slots for Package 4 (Analysis Studio), Package 5 (Reports & Case Presentation), and Package 6 (AQLAN AI Assistant) */
  renderAnalysisTab?: (ctx: {
    record: OrthoWorkspaceRecord;
    canEdit: boolean;
    canPerform: boolean;
    canApprove: boolean;
    actorName: string;
    onChange: (next: OrthoWorkspaceRecord) => void;
  }) => React.ReactNode;
  renderReportsTab?: (ctx: {
    record: OrthoWorkspaceRecord;
    patientId: number;
    patientName: string;
    patientCode: string;
    canCreatePresentation: boolean;
    canExport: boolean;
    canPrint: boolean;
    onChange: (next: OrthoWorkspaceRecord) => void;
  }) => React.ReactNode;
  renderAiDrawer?: (ctx: {
    open: boolean;
    onClose: () => void;
    record: OrthoWorkspaceRecord;
    patientId: number;
  }) => React.ReactNode;
}

export function AdvancedOrthoWorkspace({
  patientId,
  patientName,
  patientCode,
  hasActiveOrthoCase,
  context,
  onContextChange,
  onClinicalChange,
  onNavigationGuardChange,
  onOpenTreatmentEntry,
  onOpenAccount,
  renderAnalysisTab,
  renderReportsTab,
  renderAiDrawer,
}: AdvancedOrthoWorkspaceProps) {
  const session = useSession();
  const actorName = session?.username ?? "الطبيب";
  const perms = useOrthoPermissions({ enabled: true, patientId });

  const [activeTab, setActiveTab] = useState<OrthoWorkspaceTabId>(() => {
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search).get("orthoTab") as OrthoWorkspaceTabId | null;
      if (q && ORTHO_WORKSPACE_TABS.some((t) => t.id === q)) return q;
    }
    // Preserve zero-click daily tightening access for active cases
    return hasActiveOrthoCase ? "sessions" : "overview";
  });

  const [record, setRecord] = useState<OrthoWorkspaceRecord>(() =>
    createDefaultOrthoWorkspace(patientId),
  );
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRecordRef = useRef<OrthoWorkspaceRecord>(record);

  const loadWorkspace = useCallback(async () => {
    if (perms.loading) return;
    if (!perms.moduleVisible || !perms.can("records.read")) {
      setLoadingWorkspace(false);
      return;
    }
    setLoadingWorkspace(true);
    try {
      const res = await fetch(`/api/ortho/workspace/${patientId}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { workspace?: OrthoWorkspaceRecord };
        if (data.workspace) {
          setRecord(data.workspace);
          latestRecordRef.current = data.workspace;
        }
      }
    } finally {
      setLoadingWorkspace(false);
    }
  }, [patientId, perms.loading, perms.moduleVisible, perms.can]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const persistWorkspace = useCallback(
    async (next: OrthoWorkspaceRecord) => {
      setSaveState("saving");
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
          setSaveState("error");
          setSaveError(data?.message ?? "تعذّر حفظ بيانات مساحة عمل التقويم.");
          return;
        }
        if (data?.workspace) {
          setRecord(data.workspace);
          latestRecordRef.current = data.workspace;
        }
        setSaveState("saved");
      } catch {
        setSaveState("error");
        setSaveError("تعذّر الاتصال بالخادم لحفظ ملف التقويم.");
      }
    },
    [patientId],
  );

  const handleRecordChange = useCallback(
    (next: OrthoWorkspaceRecord) => {
      setRecord(next);
      latestRecordRef.current = next;
      setSaveState("dirty");
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = setTimeout(() => {
        void persistWorkspace(latestRecordRef.current);
      }, 900);
    },
    [persistWorkspace],
  );

  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, []);

  const visibleTabs = useMemo(() => {
    if (!perms.moduleVisible) return [];
    // Blind-create users (no records.read) only see the sessions intake flow
    if (!perms.can("records.read") && perms.can("records.blind_create")) {
      return ORTHO_WORKSPACE_TABS.filter((t) => t.id === "sessions");
    }
    return ORTHO_WORKSPACE_TABS.filter((t) => perms.canSection(t.sectionKey));
  }, [perms]);

  useEffect(() => {
    if (!perms.loading && visibleTabs.length > 0 && !visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [perms.loading, visibleTabs, activeTab]);

  if (perms.loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
        جارٍ التحقق من صلاحيات وحدة التقويم…
      </div>
    );
  }

  if (!perms.moduleVisible) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-xs text-amber-900 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span>وحدة تقويم الأسنان مخفية لحسابك وفق إعدادات الخصوصية والصلاحيات المعتمدة من المالك.</span>
      </div>
    );
  }

  const completeness = computeOrthoWorkspaceCompleteness(record);
  const canEdit = perms.can("records.edit") || perms.can("records.create");
  const isBlindOnly = !perms.can("records.read") && perms.can("records.blind_create");

  return (
    <div className="space-y-4">
      {/* Unified OrthoCore-Inspired Clinical Header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-extrabold text-navy-900">
                وحدة تقويم الأسنان المتقدمة — {patientName}
              </h2>
              {patientCode ? (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-600">
                  {patientCode}
                </span>
              ) : null}
              {isBlindOnly ? (
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900">
                  وضع الإدخال دون استعراض السجل السابق
                </span>
              ) : null}
            </div>
            {!isBlindOnly ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                <span>اكتمال السجل: <strong className="text-navy-900">{completeness.percent}%</strong></span>
                <span>· التحليلات المعتمدة: <strong>{record.approvedAnalyses.length}</strong></span>
                <span>· المشكلات المعتمدة: <strong>{record.problems.filter((p) => p.approved).length}</strong></span>
              </div>
            ) : null}
          </div>

          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {!isBlindOnly && canEdit ? (
              <button
                type="button"
                onClick={() => void persistWorkspace(latestRecordRef.current)}
                disabled={saveState === "saving"}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {saveState === "saved" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {saveState === "saving"
                  ? "جارٍ الحفظ…"
                  : saveState === "saved"
                    ? "محفوظ"
                    : saveState === "dirty"
                      ? "حفظ التغييرات"
                      : "حفظ"}
              </button>
            ) : null}

            {!isBlindOnly && perms.can("presentation.create") && perms.canSection("reports") ? (
              <button
                type="button"
                onClick={() => setActiveTab("reports")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-navy-200 bg-navy-50 px-3 py-1.5 text-xs font-extrabold text-navy-900 hover:bg-navy-100"
              >
                <Presentation className="h-3.5 w-3.5" />
                عرض الحالة (Case Presentation)
              </button>
            ) : null}

            {perms.can("ai.use") && perms.canSection("ai_assistant") && renderAiDrawer ? (
              <button
                type="button"
                onClick={() => setAiDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-navy-900"
              >
                <Sparkles className="h-3.5 w-3.5" />
                عقلان المساعد الذكي
              </button>
            ) : null}
          </div>
        </div>

        {saveError ? (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{saveError}</span>
          </div>
        ) : null}

        {/* Exact OrthoCore 10-Tab Sequential Clinical Navigation Bar */}
        <nav
          aria-label="أقسام وحدة تقويم الأسنان"
          className="flex gap-1 overflow-x-auto border-t border-slate-100 pt-3 pb-0.5"
        >
          {visibleTabs.map((t, index) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`shrink-0 rounded-xl px-3 py-2 text-xs font-extrabold transition ${
                  active
                    ? "bg-navy-800 text-white shadow-sm"
                    : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="ml-1 opacity-60">{index + 1}.</span>
                {t.ar}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Active Tab Content */}
      {loadingWorkspace && activeTab !== "sessions" ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
          جارٍ تحميل بيانات مساحة العمل…
        </div>
      ) : null}

      {!loadingWorkspace && activeTab === "overview" && perms.canSection("overview") && (
        <OrthoOverviewTab
          record={record}
          patientName={patientName}
          patientCode={patientCode}
          canEdit={canEdit}
          onNavigateTab={setActiveTab}
        />
      )}

      {!loadingWorkspace && activeTab === "questionnaire" && perms.canSection("medical_history") && (
        <OrthoQuestionnaireTab
          record={record}
          canEdit={canEdit}
          onChange={handleRecordChange}
        />
      )}

      {!loadingWorkspace && activeTab === "exam" && perms.canSection("exam") && (
        <OrthoExamTab
          record={record}
          canEdit={canEdit}
          onChange={handleRecordChange}
        />
      )}

      {!loadingWorkspace && activeTab === "media" && perms.canSection("media") && (
        <OrthoMediaAnd3DTab
          patientId={patientId}
          record={record}
          canEdit={canEdit}
          canViewPhotos={perms.can("photos.view")}
          canDownloadPhotos={perms.can("photos.download")}
          canPhotoAnalysis={perms.canSection("photo_analysis")}
          canModel3d={perms.canSection("model3d")}
          onChange={handleRecordChange}
        />
      )}

      {!loadingWorkspace && activeTab === "analysis" && perms.canSection("measurements") && (
        renderAnalysisTab ? (
          renderAnalysisTab({
            record,
            canEdit,
            canPerform: perms.can("measurements.perform"),
            canApprove: perms.can("measurements.approve"),
            actorName,
            onChange: handleRecordChange,
          })
        ) : (
          <OrthoScientificAnalysisTab
            record={record}
            actorName={actorName}
            canEdit={canEdit}
            canPerform={perms.can("measurements.perform")}
            canApprove={perms.can("measurements.approve")}
            onChange={handleRecordChange}
            onOpenCephTab={() => setActiveTab("sessions")}
          />
        )
      )}

      {!loadingWorkspace && activeTab === "diagnosis" && perms.canSection("diagnosis") && (
        <OrthoDiagnosisTab
          record={record}
          actorName={actorName}
          canEdit={canEdit}
          canApproveDiagnosis={perms.can("diagnosis.approve")}
          canReopen={perms.can("records.reopen")}
          onChange={handleRecordChange}
        />
      )}

      {!loadingWorkspace && activeTab === "plan" && perms.canSection("plan") && (
        <OrthoPlanTab
          record={record}
          actorName={actorName}
          canEdit={canEdit}
          canApprovePlan={perms.can("plan.approve")}
          canReopen={perms.can("records.reopen")}
          onChange={handleRecordChange}
        />
      )}

      {/* Tab 8: Daily Tightening & Sessions — preserves 100% of existing PatientOrtho + Package 2 Live Camera */}
      {activeTab === "sessions" && (perms.canSection("sessions") || isBlindOnly) && (
        <PatientOrtho
          patientId={patientId}
          context={context}
          onContextChange={onContextChange}
          onClinicalChange={onClinicalChange}
          onNavigationGuardChange={onNavigationGuardChange}
          onOpenTreatmentEntry={onOpenTreatmentEntry}
          onOpenAccount={onOpenAccount}
        />
      )}

      {!loadingWorkspace && activeTab === "retention" && perms.canSection("retention") && (
        <OrthoRetentionTab
          record={record}
          actorName={actorName}
          canEdit={canEdit}
          onChange={handleRecordChange}
        />
      )}

      {!loadingWorkspace && activeTab === "reports" && perms.canSection("reports") && (
        renderReportsTab ? (
          renderReportsTab({
            record,
            patientId,
            patientName,
            patientCode,
            canCreatePresentation: perms.can("presentation.create"),
            canExport: perms.can("reports.export"),
            canPrint: perms.can("reports.print"),
            onChange: handleRecordChange,
          })
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-xs text-slate-600">
            وحدة التقارير وعرض الحالة (Case Presentation PPTX/PDF).
          </div>
        )
      )}

      {/* Package 6: AQLAN AI Assistant Side Drawer */}
      {renderAiDrawer
        ? renderAiDrawer({
            open: aiDrawerOpen,
            onClose: () => setAiDrawerOpen(false),
            record,
            patientId,
          })
        : null}
    </div>
  );
}
