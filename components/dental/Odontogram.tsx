"use client";

import {
  PERMANENT_LOWER, PERMANENT_UPPER, PRIMARY_LOWER, PRIMARY_UPPER, toothName, toUniversal,
  type ToothCondition, type ToothState,
} from "@/lib/dental";

/**
 * (INV-LINK TOOTH) مخطط الأسنان (Odontogram) المشترك — مصدرٌ واحد لشكل السن وترقيمه ولونه.
 *
 * يُعرض في «مخطط الأسنان السريري» (`DentalChart`) وفي «تحديد الأسنان» لبند الفاتورة
 * (`ToothSelectionDialog`) من هذا الملف نفسه — لا نسخة ثانية قد تنحرف عنه.
 * الصفوف `dir="ltr"`: وضع المواجهة المعتاد في العيادة (يمين المريض على يسار الشاشة) حتى داخل الصفحة العربية.
 */

export const CONDITION_COLOR: Record<ToothCondition, string> = {
  healthy: "fill-white stroke-slate-300",
  caries: "fill-red-500 stroke-red-700",
  filling: "fill-sky-700 stroke-sky-900",
  rct: "fill-purple-500 stroke-purple-700",
  crown: "fill-amber-400 stroke-amber-600",
  bridge: "fill-amber-300 stroke-amber-600",
  implant: "fill-emerald-500 stroke-emerald-700",
  missing: "fill-slate-200 stroke-slate-400",
  extracted: "fill-slate-200 stroke-slate-400 opacity-40",
  impacted: "fill-indigo-300 stroke-indigo-600",
  fracture: "fill-rose-400 stroke-rose-700",
  mobility: "fill-amber-100 stroke-amber-500",
  veneer: "fill-teal-300 stroke-teal-600",
  sealant: "fill-cyan-100 stroke-cyan-500",
  bracket: "fill-orange-400 stroke-orange-600",
};

/** شكل السن: تاجٌ وجذران مع تفاصيل بصرية واضحة. */
const TOOTH_PATH = "M12 2c-3 0-4.3 1.4-6.8 1.4C2.7 3.4 1 5.4 1 8.9c0 3 .9 5 1.7 7.7.6 2 .9 4.2 1.2 6.4.3 2.2.8 3.6 2.2 3.6 1.3 0 1.7-1.4 2.1-3.6.5-2.4.8-5 2.8-5s2.3 2.6 2.8 5c.4 2.2.8 3.6 2.1 3.6 1.4 0 1.9-1.4 2.2-3.6.3-2.2.6-4.4 1.2-6.4.8-2.7 1.7-4.7 1.7-7.7 0-3.5-1.7-5.5-4.2-5.5C16.3 3.4 15 2 12 2Z";

export type NumberingSystem = "fdi" | "universal";
/** `sm` للأسنان اللبنية في المخطط السريري، `md` للدائمة، و`touch` لهدف لمسٍ ≥ 44px (نافذة الاختيار). */
export type OdontogramSize = "sm" | "md" | "touch";

const BUTTON_SIZE: Record<OdontogramSize, string> = {
  sm: "px-0.5 py-1", md: "px-0.5 py-1", touch: "min-h-[44px] min-w-[44px] px-1 py-1",
};
const SVG_SIZE: Record<OdontogramSize, string> = { sm: "h-6 w-5", md: "h-8 w-6", touch: "h-9 w-7" };
const LABEL_SIZE: Record<OdontogramSize, string> = { sm: "text-[9px]", md: "text-[9px]", touch: "text-[11px]" };

export function OdontogramRow({ teeth, chart, selected, onPick, disabled = false, chartKnown = true, system = "fdi", size = "md" }: {
  teeth: readonly number[];
  chart: ReadonlyMap<number, ToothState>;
  selected: readonly number[];
  onPick: (code: number) => void;
  disabled?: boolean;
  /** False means anatomy only: no healthy/absent/planned clinical inference. */
  chartKnown?: boolean;
  system?: NumberingSystem;
  size?: OdontogramSize;
}) {
  return (
    <div className="flex gap-0.5" dir="ltr">
      {teeth.map((code) => {
        const state = chartKnown ? chart.get(code) : undefined;
        const condition = state?.current?.condition ?? "healthy";
        const planned = (state?.planned.length ?? 0) > 0;
        const active = selected.includes(code);
        const displayLabel = system === "universal" ? toUniversal(code) : String(code);
        const isAbsent = state?.absent || condition === "missing" || condition === "extracted";

        return (
          <button
            key={code}
            type="button"
            onClick={() => onPick(code)}
            disabled={disabled}
            title={`${toothName(code)} (FDI: ${code}, Univ: ${toUniversal(code)})`}
            aria-label={`${toothName(code)}${chartKnown ? "" : " — الحالة غير متاحة"}`}
            data-chart-known={chartKnown}
            aria-pressed={active}
            data-testid={`odontogram-tooth-${code}`}
            className={`flex flex-col items-center rounded-md ${BUTTON_SIZE[size]} transition-colors ${
              active ? "bg-navy-900" : "hover:bg-navy-50"
            }`}
          >
            <span className={`${LABEL_SIZE[size]} font-bold ${active ? "text-white" : "text-slate-400"}`}>
              {displayLabel}
            </span>
            <div className="relative">
              <svg viewBox="0 0 24 30" className={SVG_SIZE[size]} aria-hidden="true">
                <path d={TOOTH_PATH} className={chartKnown ? CONDITION_COLOR[condition] : "fill-slate-100 stroke-slate-400"}
                  strokeWidth="1.2" strokeDasharray={chartKnown ? undefined : "2 2"} />
                {!chartKnown ? <text x="12" y="14" textAnchor="middle" fontSize="10" className="fill-slate-500">?</text> : null}
                {isAbsent ? (
                  // علامة X للسن المفقود أو المخلوع
                  <path d="M4 5 L20 25 M20 5 L4 25" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
                ) : null}
                {planned ? (
                  // الدائرة البرتقالية = خطة لم تُنفَّذ. تُرسم فوق الحالة لا بدلًا منها.
                  <circle cx="19" cy="5" r="4" className="fill-amber-500 stroke-white" strokeWidth="1.5" />
                ) : null}
              </svg>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * الفكّان بترتيب المخطط السريري: الدائم العلوي، (اللبني العلوي والسفلي)، الدائم السفلي — بالفواصل نفسها.
 * `touch` يكبّر الأسنان كلها لهدف لمسٍ مريح؛ وإلا فاللبنية أصغر كما في المخطط السريري.
 */
export function Odontogram({ chart, selected, onPick, disabled = false, chartKnown = true, system = "fdi", showPrimary = false, touch = false }: {
  chart: ReadonlyMap<number, ToothState>;
  selected: readonly number[];
  onPick: (code: number) => void;
  disabled?: boolean;
  /** False means anatomy only: no healthy/absent/planned clinical inference. */
  chartKnown?: boolean;
  system?: NumberingSystem;
  showPrimary?: boolean;
  touch?: boolean;
}) {
  const permanent: OdontogramSize = touch ? "touch" : "md";
  const primary: OdontogramSize = touch ? "touch" : "sm";
  const row = (teeth: readonly number[], size: OdontogramSize) => (
    <OdontogramRow teeth={teeth} chart={chart} selected={selected} onPick={onPick} disabled={disabled} chartKnown={chartKnown} system={system} size={size} />
  );
  return (
    <div className="mx-auto w-fit">
      {row(PERMANENT_UPPER, permanent)}
      {showPrimary ? (
        <>
          {row(PRIMARY_UPPER, primary)}
          <div className="my-1 h-px bg-slate-200" />
          {row(PRIMARY_LOWER, primary)}
        </>
      ) : (
        <div className="my-2 h-px bg-slate-200" />
      )}
      {row(PERMANENT_LOWER, permanent)}
    </div>
  );
}
