"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  formatMoney,
  type Currency,
} from "@/lib/money";
import { ServiceSelect } from "./ServiceSelect";
import { ToothField } from "./ToothPicker";

interface Service {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
  priceConfigured?: boolean;
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}
interface Doctor { id: number; name: string }

function servicePrice(service: Service | undefined, currency: Currency): number | null {
  if (!service) return null;
  if (currency === "YER") return service.priceConfigured === false || service.priceMinor <= 0 ? null : service.priceMinor;
  return service.priceIn?.[currency]?.minor ?? null;
}

/**
 * أقصر طريق لخطةٍ من بند واحد.
 *
 * لا يملك منطق فوترة خاصًا: يرسل إلى /api/plans V2 نفسه، لذلك سلطة السعر،
 * العملة، الطبيب، وقاعدة الفوترة تبقى في الخادم.
 */
export function QuickPlanForm({
  patientId,
  base,
  onSaved,
  onError,
}: {
  patientId: number;
  base: Currency;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [services, setServices] = useState<Service[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [tooth, setTooth] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [currency, setCurrency] = useState<Currency>(base);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [serviceResponse, doctorResponse] = await Promise.all([
          fetch("/api/services", { cache: "no-store" }),
          fetch("/api/parties?kind=doctor", { cache: "no-store" }),
        ]);
        if (serviceResponse.ok) {
          const payload = await serviceResponse.json();
          const list = (payload.services ?? payload) as Service[];
          setServices(list);
          setServiceId((current) => current ?? list[0]?.id ?? null);
        }
        if (doctorResponse.ok) {
          const payload = await doctorResponse.json();
          setDoctors(Array.isArray(payload) ? payload : payload.balances ?? []);
        }
      } catch {
        onError("تعذّر تحميل دليل الخدمات أو قائمة الأطباء.");
      }
    })();
  }, [onError]);

  const selected = services.find((service) => service.id === serviceId);
  const priceMinor = useMemo(() => servicePrice(selected, currency), [selected, currency]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || priceMinor === null || busy) return;
    setBusy(true);
    onError(null);
    try {
      const toothCode = tooth.trim() ? Number(tooth.trim()) : null;
      const title = `خطة سريعة — ${selected.name}${toothCode ? ` سن ${toothCode}` : ""}`;
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "v2",
          patientId,
          title,
          specialty: null,
          currency,
          primaryDoctorId: doctorId ? Number(doctorId) : null,
          items: [{
            serviceId: selected.id,
            quantity: 1,
            toothCode,
            surfaces: null,
            unitPriceMinor: priceMinor,
            billingRule: "on_completion",
            sessionCount: 1,
          }],
          billingMode: "per_procedure",
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

  return (
    <form onSubmit={submit} className="mb-4 rounded-2xl border-2 border-sky-300 bg-sky-50/35 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-extrabold text-navy-900">⚡ خطة سريعة</h3>
        <p className="mt-1 text-[11px] leading-5 text-slate-500">
          خدمة واحدة + السن + الطبيب. السعر يأتي من دليل المركز، والخطة تبقى خطة V2 عادية يمكن تطويرها قبل موافقة المريض.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الخدمة</span>
          <ServiceSelect
            services={services}
            value={serviceId}
            onChange={(id) => setServiceId(id || null)}
            base={currency}
            placeholder="— اختر الخدمة —"
            ariaLabel="خدمة الخطة السريعة"
          />
        </label>

        <ToothField
          value={tooth}
          onChange={setTooth}
          ariaLabel="سن الخطة السريعة"
          label={<span className="mb-1 block text-[10px] font-bold text-slate-500">السن (اختياري)</span>}
        />

        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الطبيب</span>
          <select
            value={doctorId}
            onChange={(event) => setDoctorId(event.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
          >
            <option value="">— الطبيب الافتراضي لاحقًا —</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">عملة الاتفاق</span>
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value as Currency)}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
          >
            {CURRENCIES.map((one) => <option key={one} value={one}>{CURRENCY_LABEL[one]}</option>)}
          </select>
        </label>

        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <p className="text-[9px] font-bold text-slate-400">سعر الخدمة في هذه العملة</p>
          <p className={`mt-1 text-sm font-extrabold ${priceMinor === null ? "text-rose-600" : "text-navy-900"}`}>
            {priceMinor === null ? "لا يوجد سعر صالح — استخدم الخطة المتقدمة" : formatMoney(priceMinor, currency)}
          </p>
        </div>
      </div>

      <button
        type="submit"
        disabled={busy || !selected || priceMinor === null}
        className="mt-3 w-full rounded-xl bg-sky-700 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
      >
        {busy ? "جارٍ الإنشاء…" : "أنشئ الخطة السريعة"}
      </button>
    </form>
  );
}
