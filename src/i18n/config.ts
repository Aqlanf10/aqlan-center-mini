export const LOCALES = ["ar", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "ar";

export const LOCALE_COOKIE_NAME = "aqlan_locale";

export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

export const LOCALE_LABELS: Record<Locale, string> = {
  ar: "العربية",
  en: "English",
};

export const LOCALE_HTML_LANGS: Record<Locale, string> = {
  ar: "ar",
  en: "en",
};
