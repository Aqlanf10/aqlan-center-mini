import { listServices, type Service } from "../db";
import { formatMoney, CLINIC_BASE_CURRENCY, type Currency } from "../money";
import { catalogPriceIn, foreignRatesFromSettings } from "../service-pricing";
import { DEFAULT_SERVICES } from "../services-catalog";
import type { SettingsMap } from "../settings";

/**
 * (TD-06 / TD-REG-018) دليل الأسعار كما يقرؤه المساعد الذكي — مصدرٌ واحد لثلاث أدوات.
 *
 * كانت أدوات الأسعار تعرض **الدليل الابتدائي المكتوب في الكود** بدل دليل المركز، وتبتلع خطأ
 * القاعدة فتعرض قائمةً فارغة أو قديمة كأنها الحقيقة، وتحسب «السعر السعودي» بضرب اليمني في سعر
 * الصرف (140 ⇒ أضعافٌ مضاعفة) أو بسعرٍ مكتوب في الكود حين لا يُضبط. الآن:
 *  - بقاعدة متصلة: دليل المركز وحده (`services`)؛ وإن تعذّرت قراءته ⇒ رسالة صريحة، لا أسعار.
 *  - بلا قاعدة (وضع العرض/الاختبار): الدليل الابتدائي **موسومًا** بأنه ابتدائي.
 *  - السعر الأجنبي بالدالة المعتمدة نفسها (`catalogPriceIn`): سعر المالك بتلك العملة إن قرّره (ولو
 *    صفرًا)، وإلا اليمني ÷ سعر الصرف في الإعدادات — وهو نفس سعر الصرف الذي تستعمله كل مسارات المال
 *    (بما فيه الافتراضي إن لم يحفظ المالك غيره)؛ سعرٌ غير صالح أو غير مقروء ⇒ لا تقدير.
 *  - حالة السعر تُحفظ: خدمةٌ بلا سعر مقرَّر لا تُعرض بصفر، والتقديري يُوسم.
 */

export interface AiPricedService {
  name: string;
  category: string | null;
  priceMinor: number;
  priceSarMinor: number | null;
  priceUsdMinor: number | null;
  /** false: لم يقرّر المالك سعرها بعد — لا يُعرض صفرًا. */
  priceConfigured: boolean;
  /** سعرٌ تخميني موسوم حتى يستبدله المالك. */
  priceProvisional: boolean;
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
    priceConfigured: service.priceConfigured, priceProvisional: service.priceProvisional,
  };
}

export async function loadAiPriceList(isDbConnected: boolean): Promise<AiPriceList> {
  if (!isDbConnected) {
    return {
      ok: true, source: "starter",
      services: DEFAULT_SERVICES.map((service) => ({
        name: service.name, category: service.category ?? null, priceMinor: service.priceMinor,
        priceSarMinor: null, priceUsdMinor: null, priceConfigured: true, priceProvisional: false,
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

/** السعر اليمني كما يُعرض: غير المقرَّر لا يظهر صفرًا، والتقديري موسوم. */
export function displayBasePrice(service: Pick<AiPricedService, "priceMinor" | "priceConfigured" | "priceProvisional">): string {
  if (!service.priceConfigured) return "غير مسعّر بعد";
  const text = formatMoney(service.priceMinor, CLINIC_BASE_CURRENCY);
  return service.priceProvisional ? `${text} (تقديري)` : text;
}

/**
 * السعر بعملةٍ أجنبية بالدالة المعتمدة: سعر المالك (ولو صفرًا) وإلا التحويل بسعر الصرف المحفوظ.
 * خدمةٌ غير مسعَّرة أو بلا سعر صرف صالح ⇒ null (لا رقم مخترع).
 */
export function foreignPriceMinor(
  service: Pick<AiPricedService, "priceMinor" | "priceSarMinor" | "priceUsdMinor"> & Partial<Pick<AiPricedService, "priceConfigured">>,
  currency: Extract<Currency, "SAR" | "USD">,
  settings: SettingsMap,
): number | null {
  if (service.priceConfigured === false) return null;
  return catalogPriceIn(service, currency, foreignRatesFromSettings(settings)).minor;
}
