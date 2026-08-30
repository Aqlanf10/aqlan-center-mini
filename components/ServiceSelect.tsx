"use client";

import { useMemo, useState } from "react";
import type { Currency } from "@/lib/money";
import { formatMoney } from "@/lib/money";

export interface ServiceItem {
  id: number;
  name: string;
  category: string | null;
  priceMinor: number;
  isActive?: boolean;
}

export const DENTAL_SERVICE_CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "all", label: "الكل", icon: "✨" },
  { key: "consultation", label: "فحص وتشخيص", icon: "🔍" },
  { key: "xray", label: "أشعة", icon: "📷" },
  { key: "cleaning", label: "تنظيف ولثة", icon: "✨" },
  { key: "filling", label: "حشوات", icon: "🦷" },
  { key: "rct", label: "علاج الجذور والعصب", icon: "⚡" },
  { key: "post", label: "وتد وبناء", icon: "🔩" },
  { key: "crown", label: "تيجان", icon: "👑" },
  { key: "bridge", label: "جسور", icon: "🌉" },
  { key: "veneer", label: "قشور تجميلية", icon: "💎" },
  { key: "implant", label: "زراعة", icon: "🌱" },
  { key: "surgery", label: "جراحة", icon: "⚕️" },
  { key: "extraction", label: "خلع", icon: "🔪" },
  { key: "sealant", label: "وقاية", icon: "🛡️" },
  { key: "whitening", label: "تبييض", icon: "😁" },
  { key: "ortho", label: "تقويم الأسنان", icon: "📐" },
];

/** تسميات الفئات المعيارية — نفس مفاتيح services-catalog.ts وclinical.ts */
export const CANONICAL_CATEGORY_LABEL: Record<string, string> = {
  consultation: "كشف واستشارة",
  cleaning: "تنظيف ولثة",
  filling: "حشوات",
  rct: "علاج جذور",
  post: "وتد وبناء",
  crown: "تيجان",
  bridge: "جسور",
  veneer: "قشور تجميلية",
  implant: "زراعة",
  extraction: "خلع",
  surgery: "جراحة",
  sealant: "وقاية",
  whitening: "تبييض",
  ortho: "تقويم",
  xray: "أشعة",
};

/**
 * تصنيف الخدمة إلى مفتاح معياري إنجليزي.
 *
 * المفاتيح الإنجليزية هي لغة المخطط السني (CATEGORY_TO_CONDITION في clinical.ts):
 * «حشوة نُفّذت» تصير حشوةً على المخطط بلا تسجيلٍ ثانٍ — والربط بالفئة لا باسم
 * الخدمة. لذا أي فئة حرة (عربية قديمة أو نص جديد) تُطبَّع هنا إلى المفتاح
 * المعياري إن أمكن، وما لا يُعرف يمرّ كما هو: يعمل ماليًّا بلا تحديث للمخطط.
 */
export function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return "عام";
  const cat = raw.trim();
  const lower = cat.toLowerCase();
  // المفاتيح المعيارية تمرّ كما هي
  if (CANONICAL_CATEGORY_LABEL[lower]) return lower;
  // فئات عربية قديمة أو نص حر → المفتاح المعياري
  if (/أشعة|xray/i.test(cat)) return "xray";
  if (/جراح|سويرجري/i.test(cat)) return "surgery";
  if (/زراع|غرس|implant/i.test(cat)) return "implant";
  if (/خلع|قلع|extract/i.test(cat)) return "extraction";
  if (/تقويم|أقواس|براكيت|ريتينر|ortho/i.test(cat)) return "ortho";
  if (/عصب|جذور|إندو|قناة|endodont|rct/i.test(cat)) return "rct";
  if (/وتد|كور|بناء|بوست|post|core/i.test(cat)) return "post";
  if (/جسر|bridge/i.test(cat)) return "bridge";
  if (/فينير|قشور|veneer/i.test(cat)) return "veneer";
  if (/تاج|زيركون|إيماكس|كراون|crown|zircon|emax/i.test(cat)) return "crown";
  if (/حشو|ترميم|filling/i.test(cat)) return "filling";
  if (/تبييض|whitening/i.test(cat)) return "whitening";
  if (/سد شقوق|سيلانت|sealant/i.test(cat)) return "sealant";
  if (/تنظيف|تلميع|وقائ|فلورايد|cleaning/i.test(cat)) return "cleaning";
  if (/تشخيص|كشف|استشارة|فحص|consult/i.test(cat)) return "consultation";
  if (/لثة|gum|perio/i.test(cat)) return "cleaning";
  // تجميعات الوكيل السابقة (علاجي/تركيبات/وقائي…) → أقرب معياري للعرض
  if (cat === "علاجي") return "filling";
  if (cat === "تركيبات") return "crown";
  if (cat === "وقائي") return "cleaning";
  return cat;
}

export function categoryDisplayName(cat: string): string {
  const found = DENTAL_SERVICE_CATEGORIES.find((c) => c.key === cat);
  if (found && found.key !== "all") return `${found.icon} ${found.label}`;
  const canonical = CANONICAL_CATEGORY_LABEL[cat];
  if (canonical) return canonical;
  return cat;
}

interface ServiceSelectProps {
  services: ServiceItem[];
  value: number | string | null;
  onChange: (serviceId: number, service: ServiceItem | null) => void;
  base?: Currency;
  placeholder?: string;
  className?: string;
  allowManual?: boolean;
  onManualSelect?: () => void;
  showCategoryTabs?: boolean;
  ariaLabel?: string;
}

/**
 * قائمة منسدلة ذكية مصنفة للخدمات السنية
 * تُقسّم الخدمات حسب الاختصاصات وتُسهّل البحث والتعبئة الفورية
 */
export function ServiceSelect({
  services,
  value,
  onChange,
  base = "YER",
  placeholder = "— اختر الخدمة من الدليل المصنف —",
  className = "",
  allowManual = false,
  showCategoryTabs = false,
  ariaLabel = "اختيار الخدمة",
}: ServiceSelectProps) {
  const [activeCat, setActiveCat] = useState<string>("all");
  const [search, setSearch] = useState("");

  const activeServices = useMemo(() => {
    return services.filter((s) => s.isActive !== false);
  }, [services]);

  // تجميع الخدمات حسب التصنيف
  const grouped = useMemo(() => {
    const map = new Map<string, ServiceItem[]>();
    for (const service of activeServices) {
      const cat = normalizeCategory(service.category);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(service);
    }
    return Array.from(map.entries());
  }, [activeServices]);

  // الخدمات المفلترة بالبحث أو التبويب
  const filteredServices = useMemo(() => {
    return activeServices.filter((s) => {
      const matchCat = activeCat === "all" || normalizeCategory(s.category) === activeCat;
      const matchSearch = !search.trim() || s.name.toLowerCase().includes(search.toLowerCase().trim());
      return matchCat && matchSearch;
    });
  }, [activeServices, activeCat, search]);

  const selectedService = useMemo(() => {
    if (!value) return null;
    return services.find((s) => s.id === Number(value)) ?? null;
  }, [services, value]);

  return (
    <div className="space-y-1.5">
      {showCategoryTabs ? (
        <div className="flex flex-wrap items-center gap-1">
          {DENTAL_SERVICE_CATEGORIES.map((cat) => {
            const count = cat.key === "all"
              ? activeServices.length
              : activeServices.filter((s) => normalizeCategory(s.category) === cat.key).length;
            if (count === 0 && cat.key !== "all") return null;
            const isSelected = activeCat === cat.key;
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setActiveCat(cat.key)}
                className={`rounded-lg px-2 py-1 text-[11px] font-bold transition-all ${
                  isSelected
                    ? "bg-navy-800 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                <span className="ml-1">{cat.icon}</span>
                {cat.label} ({count})
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="relative">
        <select
          value={value ? String(value) : ""}
          onChange={(e) => {
            const rawVal = e.target.value;
            if (!rawVal) {
              onChange(0, null);
              return;
            }
            const id = Number(rawVal);
            const found = services.find((s) => s.id === id) ?? null;
            onChange(id, found);
          }}
          aria-label={ariaLabel}
          className={`w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-navy-900 outline-none transition-colors focus:border-navy-800 ${className}`}
        >
          <option value="">{placeholder}</option>
          {allowManual ? <option value="manual">✍️ — بند يدوي حر —</option> : null}
          {grouped.map(([groupName, list]) => (
            <optgroup key={groupName} label={`❖ ${categoryDisplayName(groupName)}`}>
              {list.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · {formatMoney(service.priceMinor, base)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {selectedService ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
          <span className="font-semibold text-navy-800">
            {categoryDisplayName(normalizeCategory(selectedService.category))}
          </span>
          <span className="font-bold text-emerald-700">
            السعر القياسي: {formatMoney(selectedService.priceMinor, base)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
