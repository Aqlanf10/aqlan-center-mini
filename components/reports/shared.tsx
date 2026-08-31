"use client";

import { useMemo, useState } from "react";
import { formatAmount, CURRENCY_SHORT, type Currency } from "@/lib/money";
import { Icon } from "@/components/Icon";
import {
  PERIOD_PRESETS, PATIENT_STATUS_FILTERS, DEBT_STATUS_FILTERS,
  type KpiItem, type ReportColumn, type ReportRow, type ReportResult,
  type ReportOptions, type PeriodPreset, type DebtMode, type CompareMode,
} from "@/lib/reports-types";
import { DEBT_MODES } from "@/lib/reports-types";

/**
 * أدوات عرض التقارير المشتركة — كل تقرير يُصيَّر بنفس اللبنات: بطاقات أرقام،
 * جدول واحد قابل للبحث والترتيب، وإطار طباعة موحد. وبهذا يخرج PDF كل تقرير
 * بنفس الهوية بدل أن يبرمَج كل تقرير بطريقته (وثيقة المتطلبات، البند ١٥).
 */

// ─── عرض القيم ────────────────────────────────────────────────────────────────

export function moneyText(minor: number | null | undefined, currency: Currency): string {
  if (minor == null || Number.isNaN(minor)) return "—";
  return `${formatAmount(minor, currency)} ${CURRENCY_SHORT[currency]}`;
}

const TONE_STYLES: Record<string, string> = {
  calm: "border-slate-200 bg-white text-navy-900",
  good: "border-success-300 bg-success-50 text-success-900",
  warn: "border-warning-300 bg-warning-50 text-warning-900",
  bad: "border-danger-300 bg-danger-50 text-danger-900",
  info: "border-navy-200 bg-navy-50 text-navy-900",
};

export function KpiGrid({ kpis, base }: { kpis: KpiItem[]; base: Currency }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {kpis.map((kpi) => (
        <div
          key={kpi.key}
          className={`rounded-2xl border p-3 text-center shadow-xs ${TONE_STYLES[kpi.tone ?? "calm"]}`}
        >
          <p className="text-xl font-bold leading-none">
            {kpi.minor != null
              ? moneyText(kpi.minor, kpi.currency ?? base)
              : kpi.count != null
                ? kpi.count.toLocaleString("ar-YE")
                : (kpi.text ?? "—")}
          </p>
          <p className="mt-1.5 text-[11px] font-semibold opacity-75">{kpi.label}</p>
          {kpi.hint ? <p className="mt-0.5 text-[10px] font-medium opacity-50">{kpi.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

// ─── الجدول الموحد: بحث + ترتيب + نقر مريض ─────────────────────────────────

export type SortDirection = "asc" | "desc";

export function DataTable({
  columns, rows, base, onPatientClick, emptyText, compact,
}: {
  columns: ReportColumn[];
  rows: ReportRow[];
  base: Currency;
  onPatientClick?: (patientId: number) => void;
  emptyText?: string;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(null);

  const searchableKeys = useMemo(() => columns.map((column) => column.key), [columns]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    let output = rows;
    if (term) {
      output = rows.filter((row) =>
        searchableKeys.some((key) => String(row[key] ?? "").toLowerCase().includes(term)),
      );
    }
    if (sort) {
      output = [...output].sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        const an = typeof av === "number" ? av : Number(av);
        const bn = typeof bv === "number" ? bv : Number(bv);
        const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && av != null && bv != null;
        const cmp = numeric
          ? an - bn
          : String(av ?? "").localeCompare(String(bv ?? ""), "ar");
        return sort.direction === "asc" ? cmp : -cmp;
      });
    }
    return output;
  }, [rows, search, sort, searchableKeys]);

  const totals = useMemo(() => {
    // مجموع أعمدة المال في الأعمدة المرئية — يظهر أسفل الجدول.
    const totalsRecord: Record<string, number> = {};
    for (const column of columns) {
      if (column.type !== "money") continue;
      totalsRecord[column.key] = filtered.reduce((sum, row) => sum + Number(row[column.key] ?? 0), 0);
    }
    return totalsRecord;
  }, [columns, filtered]);

  function toggleSort(key: string) {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: "desc" };
      if (current.direction === "desc") return { key, direction: "asc" };
      return null;
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 print:hidden">
        <div className="relative flex-1 max-w-xs">
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
            <Icon name="search" className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="بحث: اسم، رقم ملف، طبيب، تخصص…"
            className="w-full rounded-xl border border-slate-200 bg-white pr-8 pl-3 py-2 text-xs text-slate-900 outline-none focus:border-brand-blue"
          />
        </div>
        {sort ? (
          <button
            type="button"
            onClick={() => setSort(null)}
            className="rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
          >
            إلغاء الترتيب
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-xs print:border-0 print:shadow-none">
        <table className="w-full min-w-max text-right text-xs">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/60 print:bg-white">
              {columns.map((column) => (
                <th
                  key={column.key}
                  onClick={() => toggleSort(column.key)}
                  className={`whitespace-nowrap px-2.5 py-2.5 font-bold text-navy-900 ${column.type === "money" || column.type === "count" || column.type === "percent" ? "" : ""} cursor-pointer select-none hover:text-brand-blue ${compact ? "text-[11px]" : ""}`}
                  title="اضغط للترتيب"
                >
                  {column.label}
                  {sort?.key === column.key ? (
                    <span className="mr-1 text-[9px]">{sort.direction === "desc" ? "▼" : "▲"}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  {search ? "لا نتائج تطابق البحث." : (emptyText ?? "لا بيانات في هذه الفترة.")}
                </td>
              </tr>
            ) : filtered.map((row, index) => (
              <tr
                key={index}
                className="border-b border-slate-50 last:border-0 odd:bg-white even:bg-slate-50/40 hover:bg-navy-50/50 print:even:bg-white"
              >
                {columns.map((column) => {
                  const value = row[column.key];
                  const isPatientLink = column.type === "link" && column.patientKey && onPatientClick;
                  const patientId = column.patientKey ? Number(row[column.patientKey]) : null;
                  return (
                    <td
                      key={column.key}
                      className={`whitespace-nowrap px-2.5 py-2 ${
                        column.type === "money" || column.type === "count" || column.type === "percent"
                          ? "font-mono tabular-nums"
                          : ""
                      } ${column.type === "money" && Number(value) < 0 ? "text-danger-700" : "text-slate-700"}`}
                    >
                      {isPatientLink && patientId ? (
                        <button
                          type="button"
                          onClick={() => onPatientClick?.(patientId)}
                          className="font-bold text-brand-blue underline decoration-brand-blue/30 hover:decoration-brand-blue print:text-navy-900 print:no-underline"
                        >
                          {String(value ?? "—")}
                        </button>
                      ) : column.type === "money" ? (
                        moneyText(Number(value ?? 0), base)
                      ) : column.type === "percent" ? (
                        `${Number(value ?? 0)}٪`
                      ) : (
                        String(value ?? "—")
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {Object.keys(totals).length > 0 && filtered.length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-navy-50/60 font-bold text-navy-900 print:bg-white">
                <td className="px-2.5 py-2.5">الإجمالي ({filtered.length} صفًا)</td>
                {columns.slice(1).map((column) => (
                  <td key={column.key} className="px-2.5 py-2.5 font-mono tabular-nums">
                    {column.type === "money" ? moneyText(totals[column.key] ?? 0, base) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}

// ─── مقارنة الفترات ──────────────────────────────────────────────────────────

export function ComparisonPanel({ comparison, base }: {
  comparison: NonNullable<ReportResult["comparison"]>;
  base: Currency;
}) {
  return (
    <section className="rounded-2xl border border-navy-100 bg-white p-4 shadow-xs">
      <p className="mb-3 text-xs font-bold text-navy-900">{comparison.title} — مقارنة</p>
      <div className="space-y-2">
        {comparison.entries.map((entry) => (
          <div key={entry.label} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
            <span className="text-xs font-bold text-slate-700">{entry.label}</span>
            <div className="flex items-center gap-3 text-xs">
              <span className="font-mono tabular-nums text-navy-900">{moneyText(entry.currentMinor, base)}</span>
              <span className="text-slate-400">←</span>
              <span className="font-mono tabular-nums text-slate-500">{moneyText(entry.previousMinor, base)}</span>
              {entry.changePercent != null ? (
                <span
                  className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${
                    entry.changePercent > 0
                      ? "bg-success-100 text-success-800"
                      : entry.changePercent < 0
                        ? "bg-danger-50 text-danger-700"
                        : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {entry.changePercent > 0 ? "+" : ""}{entry.changePercent}٪
                </span>
              ) : (
                <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">جديد</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── أشرطة بيانية بسيطة (سنوي) ──────────────────────────────────────────────

export function BarsChart({ bars, base }: { bars: { label: string; minor: number }[]; base: Currency }) {
  const max = Math.max(1, ...bars.map((bar) => bar.minor));
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs print:hidden">
      <p className="mb-3 text-xs font-bold text-navy-900">رسم بياني (اختياري)</p>
      <div className="flex items-end gap-1.5 overflow-x-auto pb-1" style={{ height: 140 }}>
        {bars.map((bar) => (
          <div key={bar.label} className="flex min-w-[42px] flex-1 flex-col items-center gap-1">
            <span className="text-[9px] font-mono tabular-nums text-slate-500">
              {bar.minor > 0 ? formatAmount(bar.minor, base) : ""}
            </span>
            <div
              className="w-full rounded-t-lg bg-gradient-to-t from-navy-300 to-navy-700 transition-all"
              style={{ height: `${Math.max(2, Math.round((bar.minor / max) * 100))}%` }}
              title={moneyText(bar.minor, base)}
            />
            <span className="text-[9px] font-bold text-slate-600">{bar.label}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-400">الأشهر على المحور، والقيمة بالمكافئ بالعملة الأساسية ({base}).</p>
    </section>
  );
}

// ─── إطار الطباعة ────────────────────────────────────────────────────────────

export function PrintFrame({ result, clinicName, generated }: {
  result: ReportResult;
  clinicName: string;
  generated: { at: string; by: string };
}) {
  return (
    <div className="hidden print:block" dir="rtl">
      <div className="mb-4 border-b-2 border-navy-900 pb-2 text-center">
        <p className="text-base font-bold">{clinicName}</p>
        <p className="mt-1 text-sm font-bold">{result.title}</p>
        <p className="text-[11px]">الفترة: {result.periodLabel}</p>
        {result.filtersLabel && result.filtersLabel !== "الفرع: الرئيسي" ? (
          <p className="text-[10px] text-slate-600">{result.filtersLabel}</p>
        ) : null}
      </div>
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 12mm; }
          body { background: white !important; }
        }
        .report-print-footer {
          display: none;
        }
        @media print {
          .report-print-footer {
            display: flex;
            position: fixed;
            bottom: 0;
            right: 0;
            left: 0;
            justify-content: space-between;
            border-top: 1px solid #cbd5e1;
            padding-top: 2mm;
            font-size: 9px;
            color: #475569;
          }
        }
      `}</style>
      <div className="report-print-footer">
        <span>أُنشئ في {generated.at.slice(0, 16).replace("T", " ")} بواسطة {generated.by}</span>
        <span>{clinicName}</span>
      </div>
    </div>
  );
}

// ─── تصدير Excel (CSV بترميز عربي سليم) ──────────────────────────────────────

export function exportCsv(filename: string, columns: ReportColumn[], rows: ReportRow[], base: Currency) {
  const header = columns.map((column) => column.label).join(",");
  const lines = rows.map((row) =>
    columns.map((column) => {
      const value = row[column.key];
      if (column.type === "money") {
        return formatAmount(Number(value ?? 0), base);
      }
      const text = String(value ?? "");
      return `"${text.replace(/"/g, '""')}"`;
    }).join(","),
  );
  const csv = `\uFEFF${[header, ...lines].join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// ─── شريط الفلاتر الموحد ─────────────────────────────────────────────────────

export interface FilterState {
  preset: PeriodPreset;
  from: string;
  to: string;
  specialty: string | null;
  doctorId: number | null;
  patientId: number | null;
  currency: "all" | Currency;
  patientStatus: "all" | "active" | "completed" | "stopped";
  debtStatus: "all" | "indebted" | "settled" | "overdue";
  debtMode: DebtMode;
  compare: CompareMode;
  method: string | null;
  receivedBy: string | null;
}

export function FilterBar({
  state, onChange, options, showDebtMode, showCompare, onPatientPicked, onApply,
}: {
  state: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  options: ReportOptions | null;
  showDebtMode: boolean;
  showCompare: boolean;
  onPatientPicked: (patient: { id: number; name: string } | null) => void;
  onApply: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<{ id: number; name: string }[]>([]);
  const [patientBusy, setPatientBusy] = useState(false);

  async function searchPatients(term: string) {
    if (term.trim().length < 2) { setPatientResults([]); return; }
    setPatientBusy(true);
    try {
      const response = await fetch(`/api/patients?q=${encodeURIComponent(term.trim())}`, { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json();
        const list = Array.isArray(payload) ? payload : (payload?.rows ?? []);
        setPatientResults(list.slice(0, 8).map((p: { id: number; fullName?: string }) => ({
          id: p.id,
          name: p.fullName ?? "",
        })));
      }
    } catch {
      setPatientResults([]);
    } finally {
      setPatientBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-xs print:hidden">
      {/* الفترة */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PERIOD_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onChange({ preset: preset.value })}
            className={`rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all ${
              state.preset === preset.value
                ? "bg-navy-900 text-white shadow-xs"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {preset.label}
          </button>
        ))}
        {state.preset === "custom" ? (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={state.from}
              onChange={(event) => onChange({ from: event.target.value })}
              className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-bold text-navy-900 outline-none focus:border-navy-800"
              aria-label="من تاريخ"
            />
            <span className="text-[11px] font-bold text-slate-500">←</span>
            <input
              type="date"
              value={state.to}
              onChange={(event) => onChange({ to: event.target.value })}
              className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-bold text-navy-900 outline-none focus:border-navy-800"
              aria-label="إلى تاريخ"
            />
          </div>
        ) : null}
      </div>

      {/* نمط المديونية (لتقارير المديونية) */}
      {showDebtMode ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2.5">
          <span className="text-[11px] font-bold text-slate-500">نوع التقرير:</span>
          {DEBT_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              title={mode.hint}
              onClick={() => onChange({ debtMode: mode.value })}
              className={`rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all ${
                state.debtMode === mode.value
                  ? "bg-amber-100 text-amber-900 border border-amber-300"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* المقارنة (للشهري) */}
      {showCompare ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2.5">
          <span className="text-[11px] font-bold text-slate-500">مقارنة مع:</span>
          {([
            { value: "none", label: "بلا مقارنة" },
            { value: "prev_period", label: "الفترة السابقة" },
            { value: "prev_year", label: "نفس الفترة قبل سنة" },
          ] as const).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange({ compare: option.value })}
              className={`rounded-xl px-3 py-1.5 text-[11px] font-bold transition-all ${
                state.compare === option.value
                  ? "bg-navy-800 text-white"
                  : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* الفلاتر المتقدمة */}
      <div className="mt-2.5 border-t border-slate-100 pt-2.5">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          className="flex items-center gap-1 text-[11px] font-bold text-navy-800 hover:text-brand-blue"
        >
          <Icon name={advancedOpen ? "close" : "settings"} className="h-3.5 w-3.5" aria-hidden="true" />
          {advancedOpen ? "إخفاء الفلاتر" : "فلاتر إضافية (فرع، تخصص، طبيب، مريض…)"}
        </button>

        {advancedOpen ? (
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">الفرع</span>
              <select
                disabled
                className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-50 px-2 py-2 text-[11px] font-bold text-slate-500"
              >
                <option>الفرع الرئيسي</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">التخصص</span>
              <select
                value={state.specialty ?? ""}
                onChange={(event) => onChange({ specialty: event.target.value || null })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                <option value="">كل التخصصات</option>
                {options?.specialties.map((specialty) => (
                  <option key={specialty.value} value={specialty.value}>{specialty.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">الطبيب</span>
              <select
                value={state.doctorId ?? ""}
                onChange={(event) => onChange({ doctorId: event.target.value ? Number(event.target.value) : null })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                <option value="">كل الأطباء</option>
                {options?.doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>{doctor.name}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">العملة</span>
              <select
                value={state.currency}
                onChange={(event) => onChange({ currency: event.target.value as FilterState["currency"] })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                <option value="all">كل العملات</option>
                <option value="YER">YER</option>
                <option value="SAR">SAR</option>
                <option value="USD">USD</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">حالة المريض</span>
              <select
                value={state.patientStatus}
                onChange={(event) => onChange({ patientStatus: event.target.value as FilterState["patientStatus"] })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                {PATIENT_STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">حالة المديونية</span>
              <select
                value={state.debtStatus}
                onChange={(event) => onChange({ debtStatus: event.target.value as FilterState["debtStatus"] })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                {DEBT_STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">طريقة الدفع</span>
              <select
                value={state.method ?? ""}
                onChange={(event) => onChange({ method: event.target.value || null })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                <option value="">الكل</option>
                {options?.methods.map((method) => (
                  <option key={method.value} value={method.value}>{method.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">المستلِم</span>
              <select
                value={state.receivedBy ?? ""}
                onChange={(event) => onChange({ receivedBy: event.target.value || null })}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] font-bold text-navy-900 outline-none focus:border-brand-blue"
              >
                <option value="">الجميع</option>
                {options?.receivers.map((receiver) => (
                  <option key={receiver} value={receiver}>{receiver}</option>
                ))}
              </select>
            </label>

            {/* المريض: بحث واختيار */}
            <div className="relative sm:col-span-2">
              <span className="mb-1 block text-[10px] font-bold text-slate-600">المريض</span>
              <input
                type="search"
                value={patientSearch}
                onChange={(event) => {
                  setPatientSearch(event.target.value);
                  void searchPatients(event.target.value);
                }}
                placeholder="ابحث بالاسم أو رقم الهاتف…"
                className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-navy-900 outline-none focus:border-brand-blue"
              />
              {state.patientId ? (
                <button
                  type="button"
                  onClick={() => { onPatientPicked(null); setPatientSearch(""); }}
                  className="absolute left-1 top-6 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-red-50 hover:text-red-700"
                >
                  مسح
                </button>
              ) : null}
              {patientResults.length > 0 ? (
                <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                  {patientResults.map((patient) => (
                    <li key={patient.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPatientPicked(patient);
                          setPatientSearch(patient.name);
                          setPatientResults([]);
                        }}
                        className="w-full px-3 py-2 text-right text-[11px] font-bold text-navy-900 hover:bg-navy-50"
                      >
                        {patient.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : patientBusy ? (
                <p className="mt-1 text-[10px] text-slate-400">جارٍ البحث…</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5">
        <p className="text-[10px] font-medium text-slate-400">
          {state.preset === "custom" ? `${state.from} → ${state.to}` : "الفترة تُحلّ تلقائيًا بتوقيت العيادة عند التطبيق"}
        </p>
        <button
          type="button"
          onClick={onApply}
          className="rounded-xl bg-navy-900 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-navy-800"
        >
          تطبيق وإظهار التقرير
        </button>
      </div>
    </div>
  );
}
