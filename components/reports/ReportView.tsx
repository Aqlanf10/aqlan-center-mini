"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { DataTable, KpiGrid, ComparisonPanel, BarsChart, PrintFrame, exportCsv, exportExcel } from "./shared";
import type { ReportResult } from "@/lib/reports-types";

/**
 * عارض التقرير — يأخذ نتيجة جاهزة من المحرك ويصيّرها باللبنات المشتركة.
 *
 * Drill-down (البند ١٣): رقم إجمالي → صفوف المرضى → كشف حساب. النقرة على اسم
 * مريض تفتح كشفه داخل المركز دون مغادرة الفلاتر.
 */
export function ReportView({
  result, clinicName, generated, printHref, visibleColumns, onVisibleColumnsChange, onPatientClick, onBack,
}: {
  result: ReportResult;
  clinicName: string;
  generated: { at: string; by: string };
  printHref: string;
  visibleColumns: string[] | null;
  onVisibleColumnsChange: (columns: string[] | null) => void;
  onPatientClick: (patientId: number) => void;
  onBack?: () => void;
}) {
  const [columnsOpen, setColumnsOpen] = useState(false);
  const availableColumns = result.columns ?? [];
  const visibleSet = visibleColumns ? new Set(visibleColumns) : null;
  const displayColumns = visibleSet
    ? availableColumns.filter((column) => visibleSet.has(column.key))
    : availableColumns;
  const safeColumns = displayColumns.length > 0 ? displayColumns : availableColumns;

  function toggleColumn(key: string) {
    const active = new Set(
      visibleColumns && visibleColumns.length > 0
        ? visibleColumns.filter((columnKey) => availableColumns.some((column) => column.key === columnKey))
        : availableColumns.map((column) => column.key),
    );
    if (active.has(key)) {
      if (active.size === 1) return;
      active.delete(key);
    } else {
      active.add(key);
    }
    const ordered = availableColumns.map((column) => column.key).filter((columnKey) => active.has(columnKey));
    onVisibleColumnsChange(ordered.length === availableColumns.length ? null : ordered);
  }

  return (
    <div className="space-y-4">
      <PrintFrame result={result} clinicName={clinicName} generated={generated} />

      {/* الترويسة على الشاشة */}
      <header className="flex flex-wrap items-start justify-between gap-2 print:hidden">
        <div>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="mb-1 inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-navy-800"
            >
              <Icon name="back" className="h-3 w-3" aria-hidden="true" />
              رجوع إلى التقرير
            </button>
          ) : null}
          <h2 className="text-lg font-bold leading-tight text-navy-900">{result.title}</h2>
          <p className="text-xs font-medium text-slate-500">
            {result.subtitle ? `${result.subtitle} · ` : ""}{result.periodLabel}
          </p>
        </div>
        <div className="relative flex flex-wrap gap-1.5">
          {result.columns && result.columns.length > 1 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setColumnsOpen((value) => !value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
              >
                الأعمدة {visibleColumns ? `(${safeColumns.length}/${availableColumns.length})` : ""}
              </button>
              {columnsOpen ? (
                <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
                  <p className="mb-1.5 px-1 text-[10px] font-bold text-slate-500">اختر الأعمدة الظاهرة</p>
                  <div className="max-h-72 space-y-1 overflow-y-auto">
                    {availableColumns.map((column) => {
                      const checked = !visibleColumns || visibleColumns.includes(column.key);
                      return (
                        <label key={column.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] hover:bg-slate-50">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleColumn(column.key)}
                          />
                          <span>{column.label}</span>
                        </label>
                      );
                    })}
                  </div>
                  {visibleColumns ? (
                    <button
                      type="button"
                      onClick={() => onVisibleColumnsChange(null)}
                      className="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-[10px] font-bold text-slate-600"
                    >
                      إظهار كل الأعمدة
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {result.actions?.length ? result.actions.map((action) => (
            <a
              key={action.href}
              href={action.href}
              target="_blank"
              rel="noopener"
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
            >
              {action.label}
            </a>
          )) : null}
          {result.rows && result.columns ? (
            <>
              <button
                type="button"
                onClick={() => exportExcel(result.report, safeColumns, result.rows!, result.baseCurrency)}
                className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
              >
                <Icon name="download" className="h-3.5 w-3.5" aria-hidden="true" />
                Excel
              </button>
              <button
                type="button"
                onClick={() => exportCsv(result.report, safeColumns, result.rows!, result.baseCurrency)}
                className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-navy-800 hover:bg-slate-50"
              >
                <Icon name="download" className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </button>
            </>
          ) : null}
          <a
            href={printHref}
            target="_blank"
            rel="noopener"
            className="flex items-center gap-1 rounded-xl bg-navy-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-navy-800"
          >
            <Icon name="print" className="h-3.5 w-3.5" aria-hidden="true" />
            مستند رسمي / PDF
          </a>
        </div>
      </header>

      {/* في الطباعة: اسم التقرير والفترة فقط (الباقي في PrintFrame) */}
      <div className="hidden print:block">
        <p className="text-[11px] text-slate-600">{result.notes?.[0] ?? ""}</p>
      </div>

      <KpiGrid kpis={result.kpis} base={result.baseCurrency} />

      {result.comparison ? <ComparisonPanel comparison={result.comparison} base={result.baseCurrency} /> : null}

      {result.bars && result.bars.length > 0 ? <BarsChart bars={result.bars} base={result.baseCurrency} /> : null}

      {result.monthly && result.monthly.rows.length > 0 ? (
        <section className="space-y-2">
          <p className="text-xs font-bold text-navy-900">التفصيل الشهري</p>
          <DataTable
            columns={result.monthly.columns}
            rows={result.monthly.rows}
            base={result.baseCurrency}
            compact
          />
        </section>
      ) : null}

      {result.rows && result.columns ? (
        <section className="space-y-2">
          {result.monthly ? <p className="text-xs font-bold text-navy-900">التفاصيل</p> : null}
          <DataTable
            columns={safeColumns}
            rows={result.rows}
            base={result.baseCurrency}
            onPatientClick={onPatientClick}
          />
        </section>
      ) : null}

      {result.notes && result.notes.length > 0 ? (
        <footer className="rounded-2xl border border-slate-100 bg-slate-50 p-3 print:mt-4 print:border-slate-300">
          <p className="mb-1 text-[11px] font-bold text-slate-600">قراءة الأرقام:</p>
          <ul className="list-inside list-disc space-y-0.5 text-[11px] leading-relaxed text-slate-500">
            {result.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </footer>
      ) : null}

      <p className="text-[10px] text-slate-400 print:hidden">
        أُنشئ في {generated.at.slice(0, 16).replace("T", " ")} بواسطة {generated.by} · العملة الأساسية: {result.baseCurrency}
      </p>
    </div>
  );
}
