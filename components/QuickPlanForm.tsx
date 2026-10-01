"use client";

import { useEffect, useMemo, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { normalizeCategory } from "./ServiceSelect";
import { ToothField } from "./ToothPicker";
import { QuickServicePicker, catalogPriceFor, useCatalog, type CatalogService } from "./QuickServicePicker";

interface Doctor { id: number; name: string }

type QuickBillingRule = "on_completion" | "on_start" | "per_session";

interface QuickLine {
  key: number;
  serviceId: number;
  tooth: string;
  sessions: number;
}

/** الحالات الشائعة — زرٌّ يفتح الدليل على فئتها، وعدد الجلسات المعتاد اقتراحٌ يُعدَّل. */
export const QUICK_PRESETS: { label: string; icon: string; category: string; sessions: number }[] = [
  { label: "حشوة", icon: "🦷", category: "filling", sessions: 1 },
  { label: "عصب", icon: "⚡", category: "rct", sessions: 3 },
  { label: "تاج", icon: "👑", category: "crown", sessions: 2 },
  { label: "خلع", icon: "🔪", category: "extraction", sessions: 1 },
  { label: "تنظيف", icon: "✨", category: "cleaning", sessions: 1 },
  { label: "تقويم", icon: "📐", category: "ortho", sessions: 1 },
];

const DEFAULT_SESSIONS: Record<string, number> = { rct: 3, crown: 2, bridge: 2, implant: 3, post: 1 };

const RULE_LABEL: Record<QuickBillingRule, string> = {
  on_completion: "عند الإنجاز",
  on_start: "عند البدء",
  per_session: "موزّع على الجلسات",
};

/**
 * (P2) الخطة السريعة — مدخلٌ مختصر لمحرك V2 نفسه، لا محرك ثانٍ.
 *
 * يرسل إلى `POST /api/plans` بـ mode="v2": الخادم يقرأ اسم الخدمة وفئتها من الدليل
 * ويفحص السعر بسلطة التسعير (checkInvoiceAuthority) بعملة الخطة. السعر هنا يُعرض من الدليل
 * ولا يُكتب يدويًا — من يحتاج سعرًا مختلفًا أو تفاصيل أكثر يفتح «الخطة المتقدمة».
 */
export function QuickPlanForm({
  patientId,
  base,
  onSaved,
  onError,
  onAdvanced,
}: {
  patientId: number;
  base: Currency;
  onSaved: () => void;
  onError: (message: string | null) => void;
  /** يفتح نموذج V2 الكامل بدل تكراره. */
  onAdvanced?: () => void;
}) {
  const { services, error: catalogError } = useCatalog();
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [lines, setLines] = useState<QuickLine[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [currency, setCurrency] = useState<Currency>(base);
  const [rule, setRule] = useState<QuickBillingRule>("on_completion");
  const [title, setTitle] = useState("");
  const [picker, setPicker] = useState<{ category: string; sessions: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(1);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/parties?kind=doctor", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
      } catch {
        // الطبيب اختياري هنا — الخطة تُنشأ بلا طبيب أساسي ويُحدَّد لاحقًا.
      }
    })();
  }, []);

  const byId = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const priced = lines.map((line) => {
    const service = byId.get(line.serviceId);
    const price = service ? catalogPriceFor(service, currency) : { minor: null, state: "no_rate" as const };
    return { line, service, price };
  });
  const missingPrice = priced.some((row) => row.price.minor === null);
  const totalMinor = priced.reduce((sum, row) => sum + (row.price.minor ?? 0), 0);

  const addService = (service: CatalogService, presetSessions: number | null) => {
    const category = normalizeCategory(service.category);
    setLines((current) => [...current, {
      key: seq, serviceId: service.id, tooth: "",
      sessions: presetSessions ?? DEFAULT_SESSIONS[category] ?? 1,
    }]);
    setSeq((value) => value + 1);
  };
  const updateLine = (key: number, patch: Partial<QuickLine>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || lines.length === 0 || missingPrice) return;
    setBusy(true);
    onError(null);
    try {
      const first = priced[0]?.service?.name ?? "خطة";
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "v2",
          patientId,
          title: title.trim() || `خطة سريعة — ${first}${lines.length > 1 ? ` (+${lines.length - 1})` : ""}`,
          specialty: null,
          currency,
          primaryDoctorId: doctorId ? Number(doctorId) : null,
          billingMode: "per_procedure",
          items: priced.map(({ line, price }) => ({
            serviceId: line.serviceId,
            quantity: 1,
            toothCode: line.tooth.trim() ? Number(line.tooth.trim()) : null,
            surfaces: null,
            unitPriceMinor: price.minor,
            billingRule: rule,
            sessionCount: Math.max(1, Math.min(20, Math.round(line.sessions) || 1)),
          })),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        onError(payload?.message ?? "تعذّر إنشاء الخطة السريعة.");
        return;
      }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs";
  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border-2 border-sky-300 bg-sky-50/35 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-extrabold text-navy-900">⚡ خطة سريعة</h3>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            اختر الحالة ثم الخدمة — السعر من دليل المركز، والخطة خطة V2 عادية تُعدَّل قبل موافقة المريض.
          </p>
        </div>
        {onAdvanced ? (
          <button type="button" onClick={onAdvanced}
            className="rounded-xl border border-navy-800 bg-white px-3 py-1.5 text-[11px] font-black text-navy-800">
            ⚙️ خطة متقدمة
          </button>
        ) : null}
      </div>

      {catalogError ? (
        <p className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700">{catalogError}</p>
      ) : null}

      <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {QUICK_PRESETS.map((preset) => (
          <button key={preset.category} type="button"
            onClick={() => setPicker({ category: preset.category, sessions: preset.sessions })}
            className="rounded-2xl border border-sky-200 bg-white px-2 py-3 text-center text-xs font-extrabold text-navy-900 hover:border-sky-400">
            <span className="block text-lg">{preset.icon}</span>{preset.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => setPicker({ category: "all", sessions: null })}
        className="mb-3 w-full rounded-xl border border-dashed border-sky-300 bg-white py-2 text-[11px] font-black text-sky-800">
        🔍 خدمة أخرى من الدليل
      </button>

      {priced.length > 0 ? (
        <ul className="mb-3 space-y-2">
          {priced.map(({ line, service, price }) => (
            <li key={line.key} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <p className="text-sm font-extrabold text-navy-900">{service?.name ?? "خدمة"}</p>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-extrabold ${price.minor === null ? "text-rose-600" : "text-emerald-700"}`}>
                    {price.minor === null ? "لا سعر صالح" : formatMoney(price.minor, currency)}
                  </span>
                  <button type="button" aria-label="حذف البند"
                    onClick={() => setLines((current) => current.filter((one) => one.key !== line.key))}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-black text-slate-500">✕</button>
                </div>
              </div>
              {price.state === "provisional" ? (
                <p className="mb-2 text-[10px] font-bold text-amber-700">سعر مؤقت في الدليل — راجعه مع الإدارة.</p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <ToothField value={line.tooth} onChange={(tooth) => updateLine(line.key, { tooth })}
                  ariaLabel="سن البند"
                  label={<span className="mb-1 block text-[10px] font-bold text-slate-500">السن (اختياري)</span>} />
                <label>
                  <span className="mb-1 block text-[10px] font-bold text-slate-500">الجلسات</span>
                  <input type="number" min={1} max={20} value={line.sessions} dir="ltr" inputMode="numeric"
                    onChange={(event) => updateLine(line.key, { sessions: Number(event.target.value) || 1 })}
                    className={field} aria-label="عدد الجلسات" />
                </label>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <details className="mb-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-black text-slate-600">الطبيب والعملة والفوترة</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label>
            <span className="mb-1 block text-[10px] font-bold text-slate-500">الطبيب</span>
            <select value={doctorId} onChange={(event) => setDoctorId(event.target.value)} className={field} aria-label="طبيب الخطة">
              <option value="">— يُحدَّد لاحقًا —</option>
              {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[10px] font-bold text-slate-500">عملة الخطة</span>
            <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} className={field} aria-label="عملة الخطة">
              {CURRENCIES.map((one) => <option key={one} value={one}>{CURRENCY_LABEL[one]}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[10px] font-bold text-slate-500">متى يُستحق المبلغ</span>
            <select value={rule} onChange={(event) => setRule(event.target.value as QuickBillingRule)} className={field} aria-label="قاعدة الفوترة">
              {(Object.keys(RULE_LABEL) as QuickBillingRule[]).map((one) => <option key={one} value={one}>{RULE_LABEL[one]}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[10px] font-bold text-slate-500">عنوان الخطة (اختياري)</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} className={field} aria-label="عنوان الخطة" />
          </label>
        </div>
      </details>

      {missingPrice ? (
        <p className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700">
          بندٌ بلا سعرٍ صالح بهذه العملة — غيّر العملة أو استخدم «الخطة المتقدمة».
        </p>
      ) : null}

      <button type="submit" disabled={busy || lines.length === 0 || missingPrice}
        className="w-full rounded-xl bg-sky-700 py-3 text-sm font-extrabold text-white disabled:opacity-40">
        {busy ? "جارٍ الإنشاء…" : lines.length === 0
          ? "اختر خدمة لبدء الخطة"
          : `أنشئ الخطة · ${formatMoney(totalMinor, currency)}`}
      </button>

      <QuickServicePicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        currency={currency}
        services={services}
        initialCategory={picker?.category ?? "all"}
        onPick={(service) => addService(service, picker?.sessions ?? null)}
        title="أضف خدمة للخطة"
      />
    </form>
  );
}
