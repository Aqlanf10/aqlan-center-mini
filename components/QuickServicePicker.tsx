"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { DENTAL_SERVICE_CATEGORIES, normalizeCategory } from "./ServiceSelect";
import { useSession } from "./SessionProvider";

/** خدمة الدليل كما يعيدها `GET /api/services` — السعر بكل عملة محسوبٌ في الخادم. */
export interface CatalogService {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
  isActive?: boolean;
  priceConfigured?: boolean;
  priceProvisional?: boolean;
  priceIn?: Partial<Record<Currency, { minor: number | null; source: "catalog" | "converted" | "none" }>>;
}

export type CatalogPriceState = "ok" | "provisional" | "unconfigured" | "no_rate";

/**
 * سعر الخدمة بعملة السياق كما سيُعرض — للعرض والاقتراح فقط.
 * سلطة السعر تبقى في الخادم (checkInvoiceAuthority): ما يُرسل يُقارن هناك بالدليل.
 */
export function catalogPriceFor(service: CatalogService, currency: Currency): { minor: number | null; state: CatalogPriceState } {
  const fromServer = service.priceIn?.[currency];
  const minor = fromServer ? fromServer.minor : currency === "YER" ? service.priceMinor : null;
  if (service.priceConfigured === false) return { minor: null, state: "unconfigured" };
  if (minor === null || minor === undefined) return { minor: null, state: "no_rate" };
  return { minor, state: service.priceProvisional ? "provisional" : "ok" };
}

const STATE_BADGE: Record<Exclude<CatalogPriceState, "ok">, { label: string; tone: string }> = {
  provisional: { label: "سعر مؤقت", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  unconfigured: { label: "غير مُسعّر", tone: "border-rose-200 bg-rose-50 text-rose-700" },
  no_rate: { label: "لا سعر بهذه العملة", tone: "border-rose-200 bg-rose-50 text-rose-700" },
};

/** تحميل الدليل مرة واحدة — بلا نسخةٍ محلية تصير مصدر حقيقة: كل فتحٍ يقرأ الخادم. */
export function useCatalog(enabled = true) {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/services", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر تحميل دليل الخدمات.");
          return;
        }
        setServices(Array.isArray(payload) ? payload : payload?.services ?? []);
        setError(null);
      } catch {
        if (!cancelled) setError("تعذّر تحميل دليل الخدمات.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled]);
  return { services, error, loading };
}

/**
 * (P3) منتقي الخدمات السريع — لوحةٌ واحدة يعاد استخدامها في الخطة السريعة وإجراءات الزيارة
 * وبنود الخطة: بحث، تصفية بالفئة، والسعر بعملة السياق مع وسم المؤقت وغير المسعّر.
 * لا يكتب سعرًا ولا يتجاوز سلطة التسعير؛ تعديل الأسعار من «/finance/services» للمدير.
 */
export function QuickServicePicker({
  open,
  onClose,
  onPick,
  currency,
  services: provided,
  title = "اختيار خدمة من الدليل",
  allowUnpriced = false,
  initialCategory = "all",
}: {
  open: boolean;
  onClose: () => void;
  onPick: (service: CatalogService, price: { minor: number | null; state: CatalogPriceState }) => void;
  currency: Currency;
  /** الدليل إن كان محمَّلًا مسبقًا في الشاشة — وإلا يُحمَّل هنا. */
  services?: CatalogService[];
  title?: string;
  /** هل يُسمح باختيار خدمة بلا سعرٍ صالح (يُكمل سعرها في نموذجٍ متقدم)؟ */
  allowUnpriced?: boolean;
  /** فئةٌ تُفتح عليها اللوحة (مثل «حشوات» من زر الاختصار). */
  initialCategory?: string;
}) {
  const session = useSession();
  const own = useCatalog(open && !provided);
  const services = provided ?? own.services;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCategory(initialCategory);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [open, onClose, initialCategory]);

  const active = useMemo(() => services.filter((service) => service.isActive !== false), [services]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const service of active) {
      const key = normalizeCategory(service.category);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [active]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return active.filter((service) =>
      (category === "all" || normalizeCategory(service.category) === category)
      && (!needle || service.name.toLowerCase().includes(needle)));
  }, [active, category, search]);

  if (!open) return null;
  const loadError = provided ? null : own.error;
  const loading = provided ? false : own.loading;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h3 className="text-sm font-extrabold text-navy-900">{title}</h3>
            <p className="text-[10px] font-semibold text-slate-500">الأسعار بعملة {CURRENCY_LABEL[currency]} كما في دليل المركز</p>
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">✕</button>
        </div>

        <div className="space-y-2 px-4 pt-3">
          <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="ابحث باسم الخدمة…" aria-label="بحث في الخدمات"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-navy-800 focus:bg-white" />
          <div className="flex gap-1 overflow-x-auto pb-1">
            {DENTAL_SERVICE_CATEGORIES.map((cat) => {
              const count = cat.key === "all" ? active.length : counts.get(cat.key) ?? 0;
              if (count === 0 && cat.key !== "all") return null;
              const on = category === cat.key;
              return (
                <button key={cat.key} type="button" onClick={() => setCategory(cat.key)} aria-pressed={on}
                  className={`shrink-0 rounded-full px-2.5 py-1.5 text-[10px] font-bold ${on ? "bg-navy-800 text-white" : "bg-slate-100 text-slate-600"}`}>
                  {cat.icon} {cat.label} ({count})
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-[200px] flex-1 overflow-y-auto px-4 py-2">
          {loading ? (
            <p className="py-8 text-center text-xs font-semibold text-slate-400">جارٍ تحميل الدليل…</p>
          ) : loadError ? (
            <p className="rounded-xl bg-rose-50 px-3 py-3 text-xs font-bold text-rose-700">{loadError}</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-xs font-semibold text-slate-400">لا خدمة تطابق البحث.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((service) => {
                const price = catalogPriceFor(service, currency);
                const pickable = allowUnpriced || price.minor !== null;
                const badge = price.state === "ok" ? null : STATE_BADGE[price.state];
                return (
                  <li key={service.id}>
                    <button type="button" disabled={!pickable}
                      onClick={() => { onPick(service, price); onClose(); }}
                      className="flex w-full items-center justify-between gap-3 py-3 text-right disabled:opacity-50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-navy-900">{service.name}</span>
                        {badge ? (
                          <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[9px] font-black ${badge.tone}`}>{badge.label}</span>
                        ) : null}
                      </span>
                      <span className={`shrink-0 text-sm font-extrabold ${price.minor === null ? "text-rose-600" : "text-emerald-700"}`}>
                        {price.minor === null ? "—" : formatMoney(price.minor, currency)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {session?.role === "admin" ? (
          <div className="border-t border-slate-100 px-4 py-3">
            <a href="/finance/services" className="block rounded-xl border border-slate-200 py-2 text-center text-xs font-black text-navy-800">
              ⚙️ إدارة الأسعار
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
