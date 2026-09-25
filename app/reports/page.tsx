"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useClinicName } from "@/components/SettingsProvider";
import { Icon, type IconName } from "@/components/Icon";
import { FilterBar, type FilterState } from "@/components/reports/shared";
import { ReportView } from "@/components/reports/ReportView";
import { financeLinks } from "@/components/financeLinks";
import type { ReportOptions, ReportResult } from "@/lib/reports-types";
import { reportIsAdminOnly } from "@/lib/report-access";
import { useSession } from "@/components/SessionProvider";

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
      { id: "visits", label: "سجل الزيارات", hint: "كل زيارة فعلية: حضور، انتظار، كرسي، طبيب وحالة" },
      { id: "appointments", label: "المواعيد", hint: "الحجوزات، الحضور، الإلغاء، عدم الحضور ونسبة الالتزام" },
      { id: "recall", label: "المتابعة والاستدعاء", hint: "المتغيبون والمنقطعون وحالة المتابعة" },
      { id: "inventory", label: "المخزون", hint: "الرصيد، حد الطلب، الإدخال والصرف خلال الفترة" },
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
      { id: "suppliers", label: "الموردون والذمم الدائنة", hint: "المستحق، المدفوع، المتبقي وتواريخ الاستحقاق" },
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
      { id: "treatment-plans", label: "خطط العلاج", hint: "الخطط الجديدة والجارية والمكتملة والموافقات والتقدم" },
      { id: "lab", label: "تقرير المختبر", hint: "الأعمال المرسلة والمتأخرة والإعادات والتكلفة" },
    ],
  },
  {
    id: "doctors",
    label: "تقارير الأطباء",
    icon: "user",
    reports: [
      { id: "doctor", label: "الطبيب والإنتاجية", hint: "حالاته، أعماله، تحصيل مرضاه، مستحقاته" },
      { id: "doctor-commission", label: "كشف عمولة الطبيب", hint: "الإنتاج، العمولة المكتسبة، المصروف، وصافي المستحق من المحرك المالي المعتمد" },
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
  const session = useSession();
  const admin = session?.role === "admin";
  const [section, setSection] = useState<SectionId>("operational");
  const [reportId, setReportId] = useState<string>("visits");
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
    serviceId: null,
    currency: "all",
    patientStatus: "all",
    debtStatus: "all",
    debtMode: "outstanding",
    compare: "none",
    method: null,
    receivedBy: null,
  });

  // الفلاتر الابتدائية للتحميل الأول وحده — لا يُعاد التحميل كلما تغيّر فلتر قبل «تطبيق».
  const initialFiltersRef = useRef(filters);

  const visibleSections = useMemo(
    () => SECTIONS
      .map((item) => ({
        ...item,
        reports: item.reports.filter((report) => admin || !reportIsAdminOnly(report.id)),
      }))
      .filter((item) => item.reports.length > 0),
    [admin],
  );

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
      if (state.serviceId) params.set("serviceId", String(state.serviceId));
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

  // أول تقرير يُحمَّل من الرابط إن كان محددًا، وإلا من الافتراضي.
  // هذا يجعل مركز التقارير قابلًا للربط المباشر من المالية/الطبيب/المختبر،
  // ويزيل الاعتماد على suppress لـ exhaustive-deps.
  useEffect(() => {
    // انتظر معرفة الدور قبل أول طلب: الاستقبال لا يجب أن يبدأ بطلب تقرير مالي
    // محجوب ثم يرى 403 لحظة فتح مركز التقارير.
    if (!session) return;

    const allowedSections = SECTIONS
      .map((item) => ({
        ...item,
        reports: item.reports.filter((report) => admin || !reportIsAdminOnly(report.id)),
      }))
      .filter((item) => item.reports.length > 0);
    if (allowedSections.length === 0) return;

    const params = new URLSearchParams(window.location.search);
    const requestedSection = params.get("section") as SectionId | null;
    const sectionDef = requestedSection
      ? allowedSections.find((item) => item.id === requestedSection)
      : undefined;
    const requestedReport = params.get("report");
    const reportSection = requestedReport
      ? allowedSections.find((item) => item.reports.some((candidate) => candidate.id === requestedReport))
      : undefined;
    const reportDef = reportSection?.reports.find((item) => item.id === requestedReport);

    const initialSection = sectionDef ?? reportSection ?? allowedSections[0];
    const initialReport = reportDef && initialSection.reports.some((item) => item.id === reportDef.id)
      ? reportDef.id
      : initialSection.reports[0].id;

    setSection(initialSection.id);
    setReportId(initialReport);
    syncReportUrl(initialSection.id, initialReport);
    void load(initialReport, initialFiltersRef.current);
  }, [admin, load, session]);

  function patchFilters(patch: Partial<FilterState>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function syncReportUrl(nextSection: SectionId, nextReport: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("section", nextSection);
    url.searchParams.set("report", nextReport);
    window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
  }

  function chooseReport(nextSection: SectionId, nextReport: string) {
    setSection(nextSection);
    setReportId(nextReport);
    setPatientDrill(null);
    syncReportUrl(nextSection, nextReport);
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
        <div className="flex flex-wrap gap-1.5">
          <a
            href="/report"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50"
          >
            التقرير التشغيلي اليومي ←
          </a>
          <a
            href="/finance/parties"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50"
          >
            كشوف الموردين والمعامل
          </a>
          <a
            href="/finance/reconciliation"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50"
          >
            ورديات وتقارير Z
          </a>
        </div>
      </PageHeader>

      {/* الأقسام الخمسة */}
      <nav className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5 print:hidden" aria-label="أقسام التقارير">
        {visibleSections.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              chooseReport(item.id, item.reports[0].id);
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
        {visibleSections.find((item) => item.id === section)?.reports.map((report) => (
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
