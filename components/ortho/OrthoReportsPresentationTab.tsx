"use client";

import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, Printer, ShieldCheck, AlertTriangle } from "lucide-react";
import type { OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";
import {
  ALL_PRESENTATION_SLIDES,
  buildCasePresentationDeck,
  type PresentationDeck,
} from "@/lib/ortho-case-presentation";
import { useClinicName } from "@/components/SettingsProvider";

export function OrthoReportsPresentationTab({
  patientId,
  patientName,
  patientCode,
  record,
  canCreatePresentation,
  canExport,
  canPrint,
  onChange,
}: {
  patientId: number;
  patientName: string;
  patientCode: string;
  record: OrthoWorkspaceRecord;
  canCreatePresentation: boolean;
  canExport: boolean;
  canPrint: boolean;
  onChange: (next: OrthoWorkspaceRecord) => void;
}) {
  const clinicName = useClinicName() || "مركز الدكتور عقلان";
  const [anonymize, setAnonymize] = useState(record.presentation.defaultAnonymize);
  const [busy, setBusy] = useState<"pptx" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printDeck, setPrintDeck] = useState<PresentationDeck | null>(null);

  const selectedIds = useMemo(() => {
    const valid = record.presentation.selectedSlideIds.filter((id) =>
      ALL_PRESENTATION_SLIDES.some((s) => s.id === id),
    );
    return valid.length > 0 ? valid : ALL_PRESENTATION_SLIDES.map((s) => s.id);
  }, [record.presentation.selectedSlideIds]);

  const previewDeck = useMemo(
    () =>
      buildCasePresentationDeck({
        clinicName,
        patientName,
        patientCode,
        record,
        selectedSlideIds: selectedIds,
        anonymize,
      }),
    [clinicName, patientName, patientCode, record, selectedIds, anonymize],
  );

  const updateSelected = (nextIds: string[]) => {
    onChange({
      ...record,
      presentation: { ...record.presentation, selectedSlideIds: nextIds },
    });
  };

  const toggleSlide = (id: string) => {
    if (selectedIds.includes(id)) {
      if (selectedIds.length <= 1) return;
      updateSelected(selectedIds.filter((x) => x !== id));
    } else {
      updateSelected([...selectedIds, id]);
    }
  };

  const moveSlide = (id: string, dir: -1 | 1) => {
    const idx = selectedIds.indexOf(id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= selectedIds.length) return;
    const copy = [...selectedIds];
    const [removed] = copy.splice(idx, 1);
    copy.splice(target, 0, removed);
    updateSelected(copy);
  };

  const exportPptx = async () => {
    if (!canCreatePresentation || !canExport) return;
    setBusy("pptx");
    setError(null);
    try {
      const res = await fetch(`/api/ortho/presentation/${patientId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pptx", anonymize, selectedSlideIds: selectedIds }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? "تعذّر تصدير العرض التقديمي.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = anonymize
        ? `AQLAN-Ortho-Case-EDU-${patientId}.pptx`
        : `AQLAN-Ortho-Case-${patientCode || patientId}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("تعذّر الاتصال بالخادم لتصدير عرض PowerPoint.");
    } finally {
      setBusy(null);
    }
  };

  const printPdf = async () => {
    if (!canCreatePresentation || !canPrint) return;
    setBusy("pdf");
    setError(null);
    try {
      const res = await fetch(`/api/ortho/presentation/${patientId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pdf", anonymize, selectedSlideIds: selectedIds }),
      });
      const data = (await res.json().catch(() => null)) as { deck?: PresentationDeck; message?: string } | null;
      if (!res.ok || !data?.deck) {
        setError(data?.message ?? "تعذّر تجهيز نسخة الطباعة.");
        return;
      }
      setPrintDeck(data.deck);
      setTimeout(() => window.print(), 120);
    } catch {
      setError("تعذّر الاتصال بالخادم لتجهيز الطباعة.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Control Header */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 no-print">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">
              توليد عرض الحالة بنقرة واحدة (Case Presentation — PPTX / PDF)
            </h3>
            <p className="text-[11px] text-slate-500">
              يُبنى العرض حصريًا من السجلات والتحليلات والتشخيصات والخطط المعتمدة مع سجل تدقيق كامل.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canCreatePresentation || !canExport || busy !== null}
              onClick={() => void exportPptx()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-3.5 py-2 text-xs font-extrabold text-white hover:bg-navy-900 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {busy === "pptx" ? "جارٍ التوليد…" : "تصدير PowerPoint قابل للتعديل (.pptx)"}
            </button>
            <button
              type="button"
              disabled={!canCreatePresentation || !canPrint || busy !== null}
              onClick={() => void printPdf()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-navy-300 bg-navy-50 px-3.5 py-2 text-xs font-extrabold text-navy-900 hover:bg-navy-100 disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" />
              {busy === "pdf" ? "جارٍ التجهيز…" : "طباعة / حفظ PDF"}
            </button>
          </div>
        </div>

        {/* Anonymization & Consent Control */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="inline-flex items-center gap-2 font-bold text-slate-800">
            <input
              type="checkbox"
              checked={anonymize}
              onChange={(e) => setAnonymize(e.target.checked)}
            />
            إخفاء هوية المريض (للعروض العلمية والتعليمية فقط)
          </label>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
              record.questionnaire.consentForEducationDeidentified
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-900"
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {record.questionnaire.consentForEducationDeidentified
              ? "موافقة المريض التعليمية موثّقة ✓"
              : "لم تُوثَّق موافقة المريض التعليمية في الاستبيان"}
          </span>
        </div>

        {previewDeck.omittedUnapprovedNotes.length > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900 space-y-1">
            <p className="font-extrabold flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              تنبيه الاعتماد السريري:
            </p>
            <ul className="list-disc pr-4 space-y-0.5 text-[11px]">
              {previewDeck.omittedUnapprovedNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 font-bold text-red-800">
            {error}
          </p>
        ) : null}
      </div>

      {/* Slide Ordering & Live Preview Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 no-print">
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <h4 className="font-extrabold text-navy-900">اختيار وترتيب الشرائح ({selectedIds.length})</h4>
          <ul className="space-y-1.5">
            {ALL_PRESENTATION_SLIDES.map((s) => {
              const checked = selectedIds.includes(s.id);
              const orderIdx = selectedIds.indexOf(s.id);
              return (
                <li
                  key={s.id}
                  className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${
                    checked ? "border-navy-200 bg-navy-50/40" : "border-slate-200 bg-slate-50 opacity-70"
                  }`}
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSlide(s.id)}
                    />
                    <span className="font-bold text-slate-800">{s.titleAr}</span>
                  </label>
                  {checked ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveSlide(s.id, -1)}
                        disabled={orderIdx === 0}
                        className="rounded p-1 hover:bg-slate-200 disabled:opacity-30"
                        title="تحريك للأعلى"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSlide(s.id, 1)}
                        disabled={orderIdx === selectedIds.length - 1}
                        className="rounded p-1 hover:bg-slate-200 disabled:opacity-30"
                        title="تحريك للأسفل"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Live Slide Preview */}
        <div className="lg:col-span-2 space-y-3">
          {previewDeck.slides.map((slide, idx) => (
            <div
              key={slide.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs"
            >
              <div className="bg-navy-900 px-4 py-3 text-white flex items-center justify-between">
                <div>
                  <h5 className="text-sm font-extrabold">{slide.titleAr}</h5>
                  <p className="text-[11px] text-slate-300">{slide.subtitleAr}</p>
                </div>
                <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-bold">
                  {slide.approvalBadgeAr} · {idx + 1}/{previewDeck.slides.length}
                </span>
              </div>
              <ul className="p-4 space-y-1.5 list-disc pr-8 text-slate-800">
                {slide.bulletsAr.map((b, bi) => (
                  <li key={bi}>{b}</li>
                ))}
              </ul>
              <div className="border-t border-slate-100 bg-slate-50 px-4 py-1.5 text-[10px] text-slate-500">
                {slide.footerAr}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Printable A4 / PDF Deck */}
      {printDeck ? (
        <div className="hidden print:block space-y-6">
          {printDeck.slides.map((slide, idx) => (
            <section
              key={slide.id}
              className="break-after-page rounded-xl border border-slate-300 p-6 space-y-3"
            >
              <div className="border-b-2 border-navy-900 pb-2 flex justify-between">
                <div>
                  <h2 className="text-lg font-extrabold text-navy-900">{slide.titleAr}</h2>
                  <p className="text-xs text-slate-600">{slide.subtitleAr}</p>
                </div>
                <span className="text-xs font-bold text-slate-500">
                  {idx + 1} / {printDeck.slides.length}
                </span>
              </div>
              <ul className="list-disc pr-6 space-y-2 text-sm text-slate-900">
                {slide.bulletsAr.map((b, bi) => (
                  <li key={bi}>{b}</li>
                ))}
              </ul>
              <footer className="pt-4 text-[11px] text-slate-500 border-t border-slate-200">
                {slide.footerAr}
              </footer>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
