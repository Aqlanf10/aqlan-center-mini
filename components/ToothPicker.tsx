"use client";

import { useState } from "react";
import { PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, toothName } from "@/lib/dental";

/**
 * (SPEC-T1) اختيار الأسنان بالنقر على مخطط FDI بدل كتابة الأرقام.
 *
 * المخطط بوضع المواجهة المعتاد في عيادات الأسنان: يمين المريض على يسار الشاشة — لذا الصفوف
 * `dir="ltr"` حتى داخل الصفحة العربية. النقر يضيف السن أو يزيله، وأزرار الفك تختار الفك كله
 * (للتقويم والتنظيف) أو تمسحه.
 */

type Arch = "upper" | "lower";

const ARCH_TEETH: Record<Arch, number[]> = { upper: PERMANENT_UPPER, lower: PERMANENT_LOWER };

/** السن يُضاف أو يُزال، والناتج مرتّبٌ تصاعديًا ليُقرأ عنوان الزيارة «سن 16، 26» ثابتًا. */
export function toggleTooth(selected: readonly number[], code: number): number[] {
  const next = selected.includes(code) ? selected.filter((tooth) => tooth !== code) : [...selected, code];
  return next.sort((a, b) => a - b);
}

/** الفك كله: إن كان مختارًا كاملًا يُزال، وإلا يُكمَّل — والأسنان الأخرى تبقى كما هي. */
export function toggleArch(selected: readonly number[], arch: Arch): number[] {
  const teeth = ARCH_TEETH[arch];
  const full = teeth.every((tooth) => selected.includes(tooth));
  const rest = selected.filter((tooth) => !teeth.includes(tooth));
  return (full ? rest : [...rest, ...teeth]).sort((a, b) => a - b);
}

export function ToothPicker({ value, onChange }: { value: readonly number[]; onChange: (teeth: number[]) => void }) {
  const [showPrimary, setShowPrimary] = useState(() => value.some((tooth) => tooth >= 51));

  const row = (teeth: number[], label: string) => (
    <div dir="ltr" role="group" aria-label={label}
      className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${teeth.length}, minmax(0, 1fr))` }}>
      {teeth.map((tooth, index) => {
        const on = value.includes(tooth);
        const midline = index === teeth.length / 2;
        return (
          <button key={tooth} type="button" onClick={() => onChange(toggleTooth(value, tooth))}
            aria-pressed={on} aria-label={`${tooth} — ${toothName(tooth)}`} title={toothName(tooth)}
            className={`h-8 min-w-0 rounded-md border text-[11px] font-bold tabular-nums ${midline ? "ml-1" : ""} ${
              on ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
            {tooth}
          </button>
        );
      })}
    </div>
  );

  const archButton = (arch: Arch, label: string) => (
    <button type="button" onClick={() => onChange(toggleArch(value, arch))}
      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-navy-900 hover:bg-slate-50">
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
      <div className="mb-1 flex justify-between text-[10px] font-bold text-slate-400" dir="ltr">
        <span>يمين المريض</span><span>يسار المريض</span>
      </div>
      <div className="space-y-1">
        {row(PERMANENT_UPPER, "الفك العلوي")}
        {showPrimary ? row(PRIMARY_UPPER, "الفك العلوي — لبنية") : null}
        <div className="border-t border-dashed border-slate-300" />
        {showPrimary ? row(PRIMARY_LOWER, "الفك السفلي — لبنية") : null}
        {row(PERMANENT_LOWER, "الفك السفلي")}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {archButton("upper", "الفك العلوي كله")}
        {archButton("lower", "الفك السفلي كله")}
        <button type="button" onClick={() => setShowPrimary((current) => !current)} aria-pressed={showPrimary}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-navy-900 hover:bg-slate-50">
          {showPrimary ? "إخفاء اللبنية" : "أسنان لبنية"}
        </button>
        {value.length > 0 ? (
          <button type="button" onClick={() => onChange([])}
            className="rounded-lg px-2 py-1 text-[11px] font-bold text-red-700 hover:bg-red-50">
            مسح
          </button>
        ) : null}
        <span className="ms-auto text-[11px] text-slate-600">
          {value.length > 0 ? `المختارة (${value.length}): ${value.join("، ")}` : "انقر على السن لاختياره."}
        </span>
      </div>
    </div>
  );
}
