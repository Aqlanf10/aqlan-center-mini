"use client";

import { useState, type ReactNode } from "react";
import { MAX_SELECTED_TEETH, PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, toothName } from "@/lib/dental";

/**
 * (SPEC-T1) اختيار الأسنان بالنقر على مخطط FDI بدل كتابة الأرقام.
 *
 * المخطط بوضع المواجهة المعتاد في عيادات الأسنان: يمين المريض على يسار الشاشة — لذا الصفوف
 * `dir="ltr"` حتى داخل الصفحة العربية. النقر يضيف السن أو يزيله، وأزرار الفك تختار الفك كله
 * (للتقويم والتنظيف) أو تمسحه.
 *
 * ويُستعمل في كل موضعٍ يُدخَل فيه سن: عدة أسنان (خطة القالب، خطاب الإحالة) بـ`ToothPicker`،
 * وسنٌّ واحد لكل إجراء أو بند (الزيارة، بنود الخطة) بـ`ToothField` — زرٌّ يفتح المخطط تحته.
 */

type Arch = "upper" | "lower";

const ARCH_TEETH: Record<Arch, number[]> = { upper: PERMANENT_UPPER, lower: PERMANENT_LOWER };

/**
 * السن يُضاف أو يُزال، والناتج مرتّبٌ تصاعديًا ليُقرأ عنوان الزيارة «سن 16، 26» ثابتًا.
 * ولا يُضاف فوق الحد (٣٢) — فالخادم يرفض ما فوقه، ولا تُعرض للطبيب خطةٌ لن تُنشأ كما رآها.
 */
export function toggleTooth(selected: readonly number[], code: number): number[] {
  if (selected.includes(code)) return selected.filter((tooth) => tooth !== code).sort((a, b) => a - b);
  if (selected.length >= MAX_SELECTED_TEETH) return [...selected];
  return [...selected, code].sort((a, b) => a - b);
}

/** الفك كله: إن كان مختارًا كاملًا يُزال، وإلا يُكمَّل — والأسنان الأخرى تبقى كما هي. */
export function toggleArch(selected: readonly number[], arch: Arch): number[] {
  const teeth = ARCH_TEETH[arch];
  const full = teeth.every((tooth) => selected.includes(tooth));
  const rest = selected.filter((tooth) => !teeth.includes(tooth));
  if (full) return rest.sort((a, b) => a - b);
  const room = MAX_SELECTED_TEETH - rest.length;
  return [...rest, ...teeth.slice(0, Math.max(room, 0))].sort((a, b) => a - b);
}

/** «14, 24» ← [14, 24] — لحقول نصية قائمة (خطاب الإحالة) تُخزِّن الأسنان نصًّا. */
export function parseTeethText(raw: string): number[] {
  const teeth = raw.split(/[\s,،;؛\-/]+/).map(Number).filter((tooth) => Number.isInteger(tooth) && tooth > 0);
  return [...new Set(teeth)].sort((a, b) => a - b);
}

export function ToothPicker({ value, onChange, single = false }: {
  value: readonly number[];
  onChange: (teeth: number[]) => void;
  /** سنٌّ واحد: النقر يستبدل الاختيار (أو يلغيه إن كان هو نفسه)، ولا أزرار للفك. */
  single?: boolean;
}) {
  const [showPrimary, setShowPrimary] = useState(() => value.some((tooth) => tooth >= 51));

  const row = (teeth: number[], label: string) => (
    <div dir="ltr" role="group" aria-label={label}
      className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${teeth.length}, minmax(0, 1fr))` }}>
      {teeth.map((tooth, index) => {
        const on = value.includes(tooth);
        const midline = index === teeth.length / 2;
        return (
          <button key={tooth} type="button"
            onClick={() => onChange(single ? (on ? [] : [tooth]) : toggleTooth(value, tooth))}
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
        {single ? null : archButton("upper", "الفك العلوي كله")}
        {single ? null : archButton("lower", "الفك السفلي كله")}
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
          {value.length === 0 ? "انقر على السن لاختياره."
            : single ? `${value[0]} — ${toothName(value[0])}` : `المختارة (${value.length}): ${value.join("، ")}`}
          {!single && value.length >= MAX_SELECTED_TEETH ? ` — الحد ${MAX_SELECTED_TEETH} سنًّا` : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * سنٌّ واحد لإجراءٍ أو بند: زرٌّ صغير بعرض الحقل القديم، والمخطط يُفتح تحته بعرض السطر كله
 * (عنصران في الصف المرن نفسه — فلا يخرج عن الشاشة على الجوال). اختيار السن يغلق المخطط.
 */
export function ToothField({ value, onChange, ariaLabel = "رقم السن", invalid = false, className = "", label }: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
  label?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tooth = Number(value);
  const selected = value.trim() && Number.isInteger(tooth) && tooth > 0 ? [tooth] : [];
  return (
    <>
      <div className={className}>
        {label}
        <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-label={ariaLabel}
          title={selected.length ? toothName(tooth) : undefined}
          className={`w-full whitespace-nowrap rounded-xl border px-2.5 py-2 text-sm font-bold ${
            invalid ? "border-danger-300 bg-danger-50 text-danger-700"
              : open ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-navy-900"}`}>
          {selected.length ? <>🦷 <span dir="ltr">{value}</span></> : <span className="font-semibold text-slate-400">🦷 السن</span>}
        </button>
      </div>
      {open ? (
        <div className="w-full basis-full">
          <ToothPicker single value={selected}
            onChange={(teeth) => { onChange(teeth.length ? String(teeth[0]) : ""); setOpen(false); }} />
        </div>
      ) : null}
    </>
  );
}
