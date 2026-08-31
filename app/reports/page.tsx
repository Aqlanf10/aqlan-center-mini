"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useClinicName } from "@/components/SettingsProvider";
import { Icon, type IconName } from "@/components/Icon";
import { FilterBar, type FilterState } from "@/components/reports/shared";
import { ReportView } from "@/components/reports/ReportView";
import { financeLinks } from "@/components/financeLinks";
import type { ReportOptions, ReportResult } from "@/lib/reports-types";

/**
 * مركز التقارير — بيت واحد لكل تقارير المركز.
 *
 * القسمة الخمس (وثيقة المتطلبات، الشكل المقترح): تشغيلية، مالية، مديونية وتحصيل،
 * سريرية وتخصصية، تقارير الأطباء. وكل تقرير فيها يستخدم شريط الفلاتر نفسه
 * وآلية الطباعة نفسها — بدل خمسة عشر تقريرًا كلٌّ بطريقته.
 */

type SectionId = "operational" | "financial" | "receivables" | "clinical" | "doctors";

interface ReportType {
  id: string;
  label: string;
  hint: string;
}

const SECTIONS: { id: SectionId; label: string; icon: IconName; reports: ReportType[] }[] = [
  {
    id: "operational",
    label: "تقارير تشغيلية",
    icon: "clock",
    reports: [
      { id: "daily", label: "التقرير اليومي", hint: "مراجعون، خدمات، تحصيل، آجل، مصروفات، صافي التدفق" },
      { id: "patients", label: "تقارير المرضى", hint: "المرضى الجدد وقيمة تعاملهم" },
    ],
  },
  {
    id: "financial",
    label: "تقارير مالية",
    icon: "wallet",
    reports: [
      { id: "monthly", label: "التقرير الشهري", hint: "مع مقارنة اختيارية بالشهر السابق أو قبل سنة" },
      { id: "annual", label: "التقرير السنوي", hint: "الأشهر الاثنا عشر + إجماليات ومتوسطات" },
      { id: "collections", label: "تقرير التحصيل", hint: "تحصيل جديد مفصولًا عن مديونية سابقة" },
      { id: "services", label: "الخدمات والإجراءات", hint: "ما أُنجز فعلًا وقيمته" },
    ],
  },
  {
    id: "receivables",
    label: "المديونية والتحصيل",
    icon: "alert",
    reports: [
      { id: "debt", label: "تقارير المديونية", hint: "مستحقة، ناشئة، محصّلة، وحركة كاملة" },
      { id: "aging", label: "أعمار الديون", hint: "حالي، ٣١–٦٠، ٦١–٩٠، ٩١–١٨٠، +١٨٠" },
    ],
  },
  {
    id: "clinical",
    label: "سريرية وتخصصية",
    icon: "tooth",
    reports: [
      { id: "specialty", label: "التقرير حسب التخصص", hint: "تقويم، زراعة، تركيبات، علاج عصب…" },
    ],
  },
  {
    id: "doctors",
    label: "تقارير الأطباء",
    icon: "user",
    reports: [
      { id: "doctor", label: "الطبيب والإنتاجية", hint: "حالاته، أعماله، تحصيل مرضاه، مستحقاته" },
    ],
  },
];

const ALL_REPORTS: ReportType[] = SECTIONS.flatMap((section) => section.reports);

interface LoadedReport {
  result: ReportResult;
  generatedAt: string;
  generatedBy: string;
}

export default function ReportsPage() {
  const clinicName = useClinicName();
  const [section, setSection] = useState<SectionId>("receivables");
  const [reportId, setReportId] = useState<string>("debt");
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [data, setData] = useState<LoadedReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patientDrill, setPatientDrill] = useState<number | null>(null);

  const [filters, setFilters] = useState<FilterState>({
    preset: "this_month",
    from: "",
    to: "",
    specialty: null,
    doctorId: null,
    patientId: null,
    currency: "all",
    patientStatus: "all",
    debtStatus: "all",
    debtMode: "outstanding",
    compare: "none",
    method: null,
    receivedBy: null,
  });

  const currentReport = useMemo(
    () => ALL_REPORTS.find((report) => report.id === reportId) ?? ALL_REPORTS[0],
    [reportId],
  );

  const load = useCallback(async (targetReport: string, state: FilterState) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ report: targetReport });
      params.set("preset", state.preset);
      if (state.preset === "custom") {
        params.set("from", state.from);
        params.set("to", state.to);
      }
      if (state.specialty) params.set("specialty", state.specialty);
      if (state.doctorId) params.set("doctorId", String(state.doctorId));
      if (state.patientId) params.set("patientId", String(state.patientId));
      if (state.currency !== "all") params.set("currency", state.currency);
      if (state.patientStatus !== "all") params.set("patientStatus", state.patientStatus);
      if (state.debtStatus !== "all") params.set("debtStatus", state.debtStatus);
      params.set("debtMode", state.debtMode);
      params.set("compare", state.compare);
      if (state.method) params.set("method", state.method);
      if (state.receivedBy) params.set("receivedBy", state.receivedBy);

      const response = await fetch(`/api/reports?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر إعداد التقرير.");
      setData(payload as LoadedReport);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر إعداد التقرير.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // خيارات الفلاتر مرة واحدة.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reports?report=options", { cache: "no-store" });
        if (response.ok && !cancelled) {
          setOptions((await response.json()) as ReportOptions);
        }
      } catch {
        // الفلاتر الأساسية تعمل بلا خيارات.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // أول تقرير يُحمَّل تلقائيًا.
  useEffect(() => {
    void load(reportId, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchFilters(patch: Partial<FilterState>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function chooseReport(nextSection: SectionId, nextReport: string) {
    setSection(nextSection);
    setReportId(nextReport);
    setPatientDrill(null);
    void load(nextReport, filters);
  }

  function openPatientStatement(patientId: number) {
    setPatientDrill(patientId);
    void load("patient-statement", { ...filters, patientId });
  }

  function backFromDrill() {
    setPatientDrill(null);
    void load(reportId, filters);
  }

  const showDebtMode = reportId === "debt";
  const showCompare = reportId === "monthly";

  return (
    <main className="mx-auto max-w-6xl p-4 pb-24">
      <PageHeader
        title="مركز التقارير"
        subtitle="فلاتر موحدة، أرقام قابلة للنقر، وطباعة واحدة لكل التقارير"
        links={financeLinks("/reports")}
      >
        <a
          href="/report"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50"
        >
          التقرير التشغيلي اليومي ←
        </a>
      </PageHeader>

      {/* الأقسام الخمسة */}
      <nav className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5 print:hidden" aria-label="أقسام التقارير">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setSection(item.id);
              setPatientDrill(null);
              setReportId(item.reports[0].id);
              void load(item.reports[0].id, filters);
            }}
            className={`flex items-center gap-2 rounded-2xl border p-3 text-right transition-all ${
              section === item.id
                ? "border-navy-900 bg-navy-900 text-white shadow-sm"
                : "border-slate-200 bg-white text-navy-900 hover:border-navy-200 hover:bg-navy-50/40"
            }`}
          >
            <Icon name={item.icon} className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="text-[11px] font-bold leading-tight">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* تقارير القسم */}
      <div className="mb-4 flex flex-wrap gap-1.5 print:hidden">
        {SECTIONS.find((item) => item.id === section)?.reports.map((report) => (
          <button
            key={report.id}
            type="button"
            title={report.hint}
            onClick={() => chooseReport(section, report.id)}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-all ${
              reportId === report.id && !patientDrill
                ? "bg-navy-800 text-white shadow-xs"
                : "border border-slate-200 bg-white text-navy-800 hover:bg-navy-50"
            }`}
          >
            {report.label}
          </button>
        ))}
      </div>

      {/* شريط الفلاتر الموحد */}
      {!patientDrill ? (
        <div className="mb-4">
          <FilterBar
            state={filters}
            onChange={patchFilters}
            options={options}
            showDebtMode={showDebtMode}
            showCompare={showCompare}
            onPatientPicked={(patient) => {
              if (patient) {
                patchFilters({ patientId: patient.id });
                void load(reportId, { ...filters, patientId: patient.id });
              } else {
                patchFilters({ patientId: null });
                void load(reportId, { ...filters, patientId: null });
              }
            }}
            onApply={() => {
              setPatientDrill(null);
              void load(reportId, filters);
            }}
          />
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-400 print:hidden">
          جارٍ إعداد {currentReport.label}…
        </div>
      ) : data ? (
        <ReportView
          result={data.result}
          clinicName={clinicName}
          generated={{ at: data.generatedAt, by: data.generatedBy }}
          onPatientClick={openPatientStatement}
          onBack={patientDrill ? backFromDrill : undefined}
        />
      ) : null}
    </main>
  );
}
