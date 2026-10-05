import type { DoctorCommissionConfig } from "@/lib/doctor-permissions";
import { DENTAL_SERVICE_CATEGORIES } from "@/lib/doctor-permissions";
import { CATEGORY_LABEL } from "@/lib/services-catalog";

type Props = {
  config: DoctorCommissionConfig;
  services: ReadonlyArray<{ category: string | null }>;
  onCategoryChange: (key: string, percent: number) => void;
  onDefaultPercentChange: (percent: number) => void;
};

/** Display raw billing keys. Merely displaying an inherited rate never creates an override.
 * Native input records a deliberate replacement even when its number is unchanged;
 * React onChange filters same-value replacements (for example inherited 0 → explicit 0).
 */
export function CommissionCategoryEditor({ config, services, onCategoryChange, onDefaultPercentChange }: Props) {
  const canonical = Object.entries(CATEGORY_LABEL);
  const canonicalKeys = new Set(canonical.map(([key]) => key));
  const otherKeys = [...new Set([
    ...Object.keys(config.categoryRates),
    ...services.flatMap((service) => service.category ? [service.category] : []),
  ])].filter((key) => !canonicalKeys.has(key)).sort();
  // Reserve padding and native spinner space without changing the stored precision.
  const inputWidth = (value: number) => `calc(${String(value).length}ch + 2.5rem)`;
  const percent = (value: string) => Math.max(0, Math.min(100, Number(value) || 0));

  const row = (key: string, label: string) => {
    const override = Object.hasOwn(config.categoryRates, key);
    const value = override ? config.categoryRates[key] : config.defaultPercent;
    return (
      <label key={key} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2">
        <span className="min-w-0 flex-[1_1_8rem] break-words">
          <span className="block font-bold text-slate-800">{label}</span>
          <span className="block break-all text-[11px] text-slate-500"><bdi>{key}</bdi> · {override ? "نسبة محددة في المسودة" : "موروثة من النسبة العامة للمسودة"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            aria-label={`نسبة فئة ${key}`}
            type="number" step="any" min={0} max={100} value={value}
            onInput={(event) => onCategoryChange(key, percent(event.currentTarget.value))}
            style={{ width: inputWidth(value) }}
            className="min-h-11 min-w-24 shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-center font-mono font-bold text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue"
          />
          <span className="text-[11px] text-slate-400">%</span>
        </span>
      </label>
    );
  };

  return (
    <section aria-label="نسب فئات الخدمات" className="rounded-xl border border-slate-200 p-4">
      <h4 className="font-black text-navy-900">مسودة نِسب الطبيب حسب فئات دليل الخدمات</h4>
      <p className="mt-1 text-xs text-slate-600">النسبة الخاصة بالخدمة لها الأولوية على نسبة الفئة. تسري التغييرات المحفوظة من لحظة الحفظ وفق أساس الاستحقاق، وتبقى الحسابات السابقة بشروطها.</p>
      <label className="my-3 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
        <span className="min-w-0 flex-[1_1_8rem] break-words text-sm font-bold text-slate-800">النسبة العامة للمسودة، للفئات بلا نسبة محددة</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <input aria-label="النسبة العامة للفئات" type="number" step="any" min={0} max={100} value={config.defaultPercent}
            onInput={(event) => onDefaultPercentChange(percent(event.currentTarget.value))}
            style={{ width: inputWidth(config.defaultPercent) }}
            className="min-h-11 min-w-24 shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-center font-mono font-bold text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue" />
          <span className="text-[11px] text-slate-400">%</span>
        </span>
      </label>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">{canonical.map(([key, label]) => row(key, label))}</div>
      {otherKeys.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 p-3">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-blue">فئات قديمة أو مخصصة ({otherKeys.length})</summary>
          <p className="my-2 text-xs text-slate-600">تُحفظ هذه المفاتيح كما هي، وتطبق على الخدمات التي تحمل المفتاح نفسه. نسبة endo لا تغيّر نسبة rct تلقائيًا.</p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">{otherKeys.map((key) => row(key, DENTAL_SERVICE_CATEGORIES.find((category) => category.key === key)?.label ?? key))}</div>
        </details>
      )}
    </section>
  );
}
