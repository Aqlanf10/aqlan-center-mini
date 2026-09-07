"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";

/**
 * نسب إهلاك المواد لكل تخصص. (من مستودع الوكيل الآخر.)
 *
 * طلبها المالك هناك بديلًا عن خصم التكلفة الفعلية: صرفُ المخزون يُسجَّل على
 * الزيارة حين يُسجَّل، وكثيرٌ منه لا يُسجَّل أصلًا — قفّازٌ ومخدّرٌ وشاشٌ لا يُعدّ.
 * فخصمُ «التكلفة الفعلية» يخصم من طبيبٍ سجّل ولا يخصم من طبيبٍ لم يسجّل، وهو
 * عقابٌ على الدقّة لا حسابٌ للتكلفة. والنسبةُ تقديرٌ متّفقٌ عليه سلفًا، معلومٌ
 * للطبيب قبل أن يعمل، سواءٌ على من سجّل ومن لم يسجّل.
 *
 * **وهي قرار المالك لا حسابُ النظام** — لا رقم افتراضي: تخصّصٌ بلا نسبةٍ محدَّدة
 * لا يُخصم منه شيء، ويُقال في تقرير العمولات كم حُصّل من عملٍ بلا نسبة.
 * والوحدة نقطةُ أساس (١٠٬٠٠٠ = ١٠٠٪) — عددٌ صحيحٌ كالمال.
 */

interface MaterialRate {
  category: string;
  rateBp: number;
  updatedBy: string;
  updatedAt: string;
}

interface CategoryOption {
  category: string;
  label: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  consultation: "الكشف والاستشارة",
  cleaning: "التنظيف والوقاية",
  filling: "الحشوات",
  rct: "علاج العصب",
  post: "الأوتاد والبناء",
  crown: "التيجان",
  bridge: "الجسور",
  veneer: "القشور التجميلية",
  surgery: "الخلع والجراحة",
  implant: "الزراعة",
  denture: "أطقم الأسنان",
  perio: "اللثة",
  orthodontics: "تقويم الأسنان",
  pediatric: "أسنان الأطفال",
  radiology: "الأشعة والتشخيص",
  cosmetic: "التجميل",
  emergency: "الطوارئ",
  other: "أخرى",
};

const labelOf = (category: string) =>
  CATEGORY_LABELS[category] ?? category;

const formatRate = (rateBp: number) =>
  `${(rateBp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

export default function MaterialRatesPage() {
  const [rates, setRates] = useState<MaterialRate[] | null>(null);
  const [categories, setCategories] = useState<CategoryOption[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [draft, setDraft] = useState({ category: "", rate: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ratesRes, servicesRes] = await Promise.all([
        fetch("/api/settings/material-rates", { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
      ]);
      const ratesPayload = await ratesRes.json();
      if (ratesRes.ok) {
        setRates(ratesPayload.rates ?? []);
        setEnabled(Boolean(ratesPayload.applied));
      } else {
        setMessage(ratesPayload?.message ?? "تعذّر تحميل النسب.");
      }
      if (servicesRes.ok) {
        const services = (await servicesRes.json()) as { category: string | null }[];
        const unique = [...new Set(services.map((service) => service.category).filter((category): category is string => Boolean(category)))];
        setCategories(unique.sort().map((category) => ({ category, label: labelOf(category) })));
      } else {
        setCategories([]);
      }
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (category: string, ratePercent: string | null) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (ratePercent !== null && !Number.isFinite(Number(ratePercent))) {
        setMessage("اكتب النسبة رقمًا صحيحًا بالمئة — 7.5 مثلًا.");
        return;
      }
      const body = ratePercent === null
        ? { category, rateBp: null }
        : { category, rate: ratePercent };
      const response = await fetch("/api/settings/material-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر حفظ النسبة.");
        return;
      }
      setMessage(ratePercent === null
        ? "مُحيت النسبة — هذا التخصص لا يُخصم منه شيء."
        : "حُفظت النسبة.");
      setDraft({ category: "", rate: "" });
      await load();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const toggleApplied = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "finance.commission_material_rate": enabled ? "off" : "on",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر تغيير التفعيل.");
        return;
      }
      setEnabled(!enabled);
      setMessage(!enabled
        ? "فُعِّل الخصم: عمولة الطبيب تُعرض بعد خصم إهلاك المواد المقدَّر."
        : "أُغلق الخصم: أرقام العمولات كما كانت.");
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-4 pb-16">
      <PageHeader
        title="نسب إهلاك المواد"
        subtitle="تقديرٌ متّفقٌ عليه يُخصم من العمولة — قرار المالك لا حساب النظام"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/finance-expenses", label: "بنود وميزانيات المصروفات" },
          { href: "/settings/material-rates", label: "نسب إهلاك المواد", current: true },
          { href: "/finance/commissions", label: "تقرير العمولات" },
        ]}
      />

      {message ? (
        <p className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-bold text-sky-900">
          {message}
        </p>
      ) : null}

      <section className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-extrabold text-amber-900">لماذا نسبةٌ لا تكلفة فعلية؟</h2>
            <p className="mt-1 text-xs leading-relaxed text-amber-800">
              صرفُ المخزون يُسجَّل على الزيارة حين يُسجَّل، وكثيرٌ منه لا يُسجَّل أصلًا. فخصم
              التكلفة الفعلية يخصم من طبيبٍ سجّل ولا يخصم من طبيبٍ لم يسجّل — عقابٌ على
              الدقّة لا حسابٌ للتكلفة. النسبةُ تقديرٌ معلومٌ للطبيب قبل أن يعمل، سواءٌ على
              من سجّل ومن لم يسجّل. وتخصّصٌ بلا نسبةٍ لا يُخصم منه شيء، ويظهر في تقرير
              العمولات «محصَّلٌ بلا نسبة».
            </p>
          </div>
          <button
            type="button"
            onClick={() => void toggleApplied()}
            disabled={busy}
            className={`shrink-0 rounded-xl px-4 py-2 text-xs font-extrabold text-white disabled:opacity-50 ${
              enabled ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-500 hover:bg-slate-600"
            }`}
            title={enabled ? "الخصم مفعّل — انقر للإغلاق" : "الخصم مغلق — انقر للتفعيل بعد تحديد النسب"}
          >
            {enabled ? "الخصم مفعّل ✓" : "تفعيل الخصم من العمولة"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-xs font-extrabold text-navy-900">النسب المحدَّدة</h2>
        {rates == null ? (
          <p className="mt-3 text-xs text-slate-400">جارٍ التحميل…</p>
        ) : rates.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">
            لا نسبةً محدَّدة بعد — تخصّصٌ بلا نسبةٍ لا يُخصم منه شيء.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {rates.map((rate) => (
              <li key={rate.category} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <p className="text-xs font-bold text-slate-800">{labelOf(rate.category)}</p>
                  <p className="text-[10px] text-slate-400">
                    {rate.updatedBy} · {new Date(rate.updatedAt).toLocaleDateString("ar")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-extrabold tabular-nums text-slate-700">
                    {formatRate(rate.rateBp)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void save(rate.category, null)}
                    disabled={busy}
                    className="rounded-lg border border-rose-200 px-2 py-1 text-[10px] font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                  >
                    محو
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-xs font-extrabold text-navy-900">تحديد نسبة</h2>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[180px]">
            <span className="mb-1 block text-[11px] font-bold text-slate-600">التخصص</span>
            <select
              value={draft.category}
              onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs"
            >
              <option value="">— اختر التخصص —</option>
              {(categories ?? []).map((option) => (
                <option key={option.category} value={option.category}>{option.label}</option>
              ))}
              {/* تخصص يدوي لمن يريد فئةً خارج الدليل */}
              <option value="__custom">فئة أخرى (اكتبها)</option>
            </select>
          </label>
          {draft.category === "__custom" ? (
            <label className="flex-1 min-w-[140px]">
              <span className="mb-1 block text-[11px] font-bold text-slate-600">اسم الفئة (لاتيني)</span>
              <input
                value={draft.category === "__custom" ? "" : draft.category}
                onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value.toLowerCase().replace(/[^a-z_-]/g, "") }))}
                placeholder="sedation"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                dir="ltr"
              />
            </label>
          ) : null}
          <label className="w-28">
            <span className="mb-1 block text-[11px] font-bold text-slate-600">النسبة %</span>
            <input
              value={draft.rate}
              onChange={(event) => setDraft((current) => ({ ...current, rate: event.target.value }))}
              placeholder="7.5"
              inputMode="decimal"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={() => void save(draft.category, draft.rate)}
            disabled={busy || !draft.category || draft.category === "__custom" || !draft.rate}
            className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-extrabold text-white disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="check" className="h-3.5 w-3.5" />
              حفظ النسبة
            </span>
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          السقف مئةٌ بالمئة: نسبةٌ فوقها تعني موادَّ كلّفت أكثر ممّا حُصّل. والنسبة
          تُخصم من **المحصَّل** لا المفوتَر — فلا يصير الطبيب مدينًا بمواد مريضٍ لم يدفع.
        </p>
      </section>
    </main>
  );
}
