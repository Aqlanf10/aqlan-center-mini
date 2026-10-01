import { listServices, type Service } from "../db";
import { MINOR_UNITS, CLINIC_BASE_CURRENCY, type Currency } from "../money";
import { DEFAULT_SERVICES } from "../services-catalog";
import { rateFromSettings, type SettingsMap } from "../settings";

/**
 * (TD-06 / TD-REG-018) دليل الأسعار كما يقرؤه المساعد الذكي — مصدرٌ واحد لثلاث أدوات.
 *
 * كانت أدوات الأسعار تعرض **الدليل الابتدائي المكتوب في الكود** بدل دليل المركز، وتبتلع خطأ
 * القاعدة فتعرض قائمةً فارغة أو قديمة كأنها الحقيقة، وتحسب «السعر السعودي» بضرب اليمني في سعر
 * الصرف (140 ⇒ أضعافٌ مضاعفة) أو بسعرٍ مكتوب في الكود حين لا يُضبط. الآن:
 *  - بقاعدة متصلة: دليل المركز وحده (`services`)؛ وإن تعذّرت قراءته ⇒ رسالة صريحة، لا أسعار.
 *  - بلا قاعدة (وضع العرض/الاختبار): الدليل الابتدائي **موسومًا** بأنه ابتدائي.
 *  - السعر الأجنبي: سعر المالك بتلك العملة إن قرّره، وإلا القسمة على سعر الصرف المضبوط؛
 *    بلا سعر مضبوط ⇒ لا تقدير (لا رقم مخترع).
 */

export interface AiPricedService {
  name: string;
  category: string | null;
  priceMinor: number;
  priceSarMinor: number | null;
  priceUsdMinor: number | null;
}

export type AiPriceList =
  | { ok: true; source: "clinic" | "starter"; services: AiPricedService[] }
  | { ok: false; message: string };

export const PRICE_LIST_UNAVAILABLE =
  "تعذّر قراءة دليل الأسعار من قاعدة البيانات الآن — لا أعرض أسعارًا قد تكون غير صحيحة. أعد المحاولة بعد قليل أو افتح شاشة الخدمات.";

export const STARTER_CATALOG_NOTE = "تنبيه: هذه أسعار الدليل الابتدائي (وضعٌ بلا قاعدة بيانات) — ليست دليل المركز المعتمد.";

function fromService(service: Service): AiPricedService {
  return {
    name: service.name, category: service.category, priceMinor: service.priceMinor,
    priceSarMinor: service.priceSarMinor, priceUsdMinor: service.priceUsdMinor,
  };
}

export async function loadAiPriceList(isDbConnected: boolean): Promise<AiPriceList> {
  if (!isDbConnected) {
    return {
      ok: true, source: "starter",
      services: DEFAULT_SERVICES.map((service) => ({
        name: service.name, category: service.category ?? null, priceMinor: service.priceMinor,
        priceSarMinor: null, priceUsdMinor: null,
      })),
    };
  }
  try {
    return { ok: true, source: "clinic", services: (await listServices(false)).map(fromService) };
  } catch (error) {
    console.error("[ai] price list unavailable:", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: PRICE_LIST_UNAVAILABLE };
  }
}

/**
 * تقدير سعر الخدمة بعملةٍ أجنبية: سعر المالك بها إن قرّره، وإلا `اليمني ÷ سعر الصرف`
 * (`finance.rate.X` = كم يمنيًّا يساوي وحدةً منها). بلا سعر صرف مضبوط ⇒ null.
 */
export function foreignPriceMinor(
  service: Pick<AiPricedService, "priceMinor" | "priceSarMinor" | "priceUsdMinor">,
  currency: Extract<Currency, "SAR" | "USD">,
  settings: SettingsMap,
): number | null {
  const own = currency === "SAR" ? service.priceSarMinor : service.priceUsdMinor;
  if (own !== null && own > 0) return own;
  const rate = rateFromSettings(settings, currency, CLINIC_BASE_CURRENCY);
  if (rate === null || rate <= 0 || service.priceMinor <= 0) return null;
  const baseMajor = service.priceMinor / MINOR_UNITS[CLINIC_BASE_CURRENCY];
  return Math.round((baseMajor / rate) * MINOR_UNITS[currency]);
}
